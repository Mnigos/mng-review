import { Clock, Context, Duration, Effect, Layer, Ref, Result } from 'effect'
import { Chat, type Prompt, type Response } from 'effect/ai'
import { TokenLedger } from '../../../../platform/llm/token-ledger.service'
import { fenceData } from '../../../../utils/fence.util'
import {
	makeConversationBudget,
	toAffordableOutputs,
	toBudgetMark,
	toEstimatedTokens,
} from '../../domain/loop-budget.helper'
import {
	toContinuationMessage,
	toToolMessage,
	toUserMessage,
} from '../../domain/loop-message.helper'
import {
	MAX_CORRECTIONS,
	TOOL_OUTPUT_LABEL,
	WRAP_UP_GRACE,
} from '../../domain/review.constants'
import { LoopError } from '../../domain/review.errors'
import { parseAnswerJson } from '../../infrastructure/answer-json.parser'
import type { LoopRequest, LoopResult, LoopState } from '../agent-loop.types'
import { AGENT_TOOLKIT } from '../agent.toolkit'
import {
	addToolReads,
	getUnreadFiles,
	NO_READS,
	type ReadCoverage,
} from '../read-coverage.helper'
import { ReviewLimits } from '../review-limits.context'
import { type ModelCallError, ModelHealthService } from './model-health.service'
import { RepoToolsService } from './repo-tools.service'

type ToolCall = Response.ToolCallPart<string, unknown>

/** A call's answer when the tool did not run or did not finish. */
function refuse(output: string) {
	return Effect.succeed({ output })
}

/**
 * Runs one agent as a tool loop on `effect/ai` `Chat`: one model call per turn, the turn's tool
 * calls resolved in parallel by the loop, until the agent calls its finish tool or answers with
 * plain JSON. Tool calls are bounded by `maxToolCalls`, wall time by `maxWallTime`; past either,
 * or once the request's `budget` runs out, the agent gets only the finish tool and must answer; an
 * answer after a budget-forced turn, corrections included, is `budgetStopped`. Repository calls after
 * the wall time are refused, and every model call ends by the wall time plus one grace period. An
 * invalid answer gets a correction turn; after `MAX_CORRECTIONS` the agent fails with a `LoopError`.
 */
export class AgentLoopService extends Context.Service<
	AgentLoopService,
	{
		readonly run: <TValue>(
			request: LoopRequest<TValue>
		) => Effect.Effect<LoopResult<TValue>, LoopError | ModelCallError>
	}
>()('mng-review/AgentLoopService') {}

export const AgentLoopServiceLive = Layer.effect(
	AgentLoopService,
	Effect.gen(function* () {
		const health = yield* ModelHealthService
		const repoTools = yield* RepoToolsService
		const limits = yield* ReviewLimits
		const ledger = yield* TokenLedger
		const wallMillis = Duration.toMillis(
			Duration.fromInputUnsafe(limits.maxWallTime)
		)
		const graceMillis = Duration.toMillis(
			Duration.fromInputUnsafe(WRAP_UP_GRACE)
		)

		const run = Effect.fn('AgentLoopService.run')(function* <TValue>(
			request: LoopRequest<TValue>
		): Effect.fn.Return<LoopResult<TValue>, LoopError | ModelCallError> {
			const { finish } = request
			const chat = yield* Chat.fromPrompt([
				{ role: 'system', content: request.system },
				{ role: 'user', content: request.user },
			])
			const firstEstimate = toEstimatedTokens(request.system + request.user)
			const deadline = (yield* Clock.currentTimeMillis) + wallMillis
			const hardDeadline = deadline + graceMillis
			const { coverage } = request
			/** What the tool outputs the model received showed (`addToolReads`). */
			const received = yield* Ref.make<ReadCoverage>(NO_READS)
			/** The answer before a continuation turn with its unread files then, kept if the continuation fails. */
			const kept = yield* Ref.make<LoopResult<TValue> | undefined>(undefined)

			const tokens = yield* makeConversationBudget(request.budget, health.spent)
			/** True once the conversation or the whole run is out of tokens, as the turn checks it. */
			const { isSpent } = tokens

			/** The answer with the files of `coverage` the agent did not receive whole, which the report counts. */
			const withUnread = (answer: LoopResult<TValue>) =>
				Effect.gen(function* () {
					if (!coverage) return answer
					const reads = yield* Ref.get(received)
					return { ...answer, unread: getUnreadFiles(reads, coverage) }
				})

			/** Files of `coverage` not received whole, when tool calls and time allow a turn. */
			const getUnread = (state: LoopState) =>
				Effect.gen(function* () {
					if (!coverage || (yield* Ref.get(kept))) return []
					if (state.toolCalls >= limits.maxToolCalls) return []
					if ((yield* Clock.currentTimeMillis) >= deadline) return []
					return getUnreadFiles(yield* Ref.get(received), coverage)
				})

			/**
			 * A parsed answer: merged into the kept one after a continuation, else held for one
			 * continuation turn when it leaves files of `coverage` unread (`isWholeRead`).
			 */
			const accept = (
				answer: LoopResult<TValue>,
				next: LoopState,
				reply: (text: string) => Prompt.MessageEncoded
			): Effect.Effect<LoopResult<TValue>, LoopError | ModelCallError> =>
				Effect.gen(function* () {
					const first = yield* Ref.get(kept)
					if (first && coverage)
						return yield* withUnread({
							...answer,
							value: coverage.merge(first.value, answer.value),
							continued: true,
							...(first.budgetStopped ? { budgetStopped: true } : {}),
						})
					const unread = yield* getUnread(next)
					if (unread.length === 0) return yield* withUnread(answer)
					const text = toContinuationMessage(unread, finish)
					const continued = {
						...next,
						nextInputTokens: next.nextInputTokens + toEstimatedTokens(text),
						pending: [reply(text)],
					}
					// The continuation must leave room for a call after it, as any turn does.
					if (yield* isSpent(continued)) return yield* withUnread(answer)
					yield* Ref.set(
						kept,
						yield* withUnread({ ...answer, continued: true })
					)
					return yield* step(continued)
				})

			/** A correction turn; out of tokens, an invalid answer gets one, not the usual allowance. */
			const correct = (
				state: LoopState,
				pending: Prompt.MessageEncoded[]
			): Effect.Effect<LoopResult<TValue>, LoopError | ModelCallError> =>
				isSpent(state).pipe(
					Effect.flatMap(spent => {
						if (state.corrections >= (spent ? 1 : MAX_CORRECTIONS))
							return Effect.fail(
								new LoopError({
									reason: `agent gave no valid ${finish} answer`,
								})
							)
						return step({
							...state,
							corrections: state.corrections + 1,
							turn: state.turn + 1,
							pending,
						})
					})
				)

			/**
			 * Runs the turn's repository calls; the first calls up to the allowance run, the rest get an
			 * error. Each call ends at the wall deadline with an error result, so a stalled git process
			 * cannot hold the agent and the grace period stays free for the finish answer. Tokens refuse
			 * no call here: `toAffordableOutputs` refuses only the outputs that do not fit.
			 */
			const resolveCalls = (
				calls: readonly ToolCall[],
				state: LoopState,
				wrapUp: boolean,
				now: number
			) => {
				const allowed = calls.filter(
					call => !wrapUp && request.tools.some(name => name === call.name)
				)
				const runnable = new Set(
					allowed
						.slice(0, Math.max(0, limits.maxToolCalls - state.toolCalls))
						.map(call => call.id)
				)
				return Effect.forEach(
					calls,
					call => {
						if (!allowed.includes(call))
							return refuse(`error: tool ${call.name} is not available`)
						if (!runnable.has(call.id))
							return refuse(`error: tool call limit reached; call ${finish}`)
						return repoTools.run(request.scope, call.name, call.params).pipe(
							Effect.timeoutOrElse({
								duration: Math.max(0, deadline - now),
								orElse: () =>
									refuse(
										`error: tool ${call.name} ran past the agent's wall time`
									),
							})
						)
					},
					{ concurrency: 'unbounded' }
				)
			}

			const step = (
				state: LoopState
			): Effect.Effect<LoopResult<TValue>, LoopError | ModelCallError> =>
				Effect.gen(function* () {
					const queuedAt = yield* Clock.currentTimeMillis
					// Decided once the call holds a concurrency slot, so time spent queued counts.
					const turn = Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis
						const spent = yield* isSpent(state)
						const wrapUp =
							state.toolCalls >= limits.maxToolCalls || now >= deadline || spent
						const prompt = [
							...state.pending,
							...(wrapUp && !state.wrapUpSent
								? [
										toUserMessage(
											`You have used up your tool calls, time or token budget. Call ${finish} now with what you have.`
										),
									]
								: []),
						]
						const response = yield* chat.generateText({
							prompt,
							toolkit: AGENT_TOOLKIT,
							toolChoice: wrapUp
								? { oneOf: [finish], mode: 'required' }
								: { oneOf: [...request.tools, finish] },
							disableToolCallResolution: true,
							toolCallValidation: 'deferred',
						})
						const expired = (yield* Clock.currentTimeMillis) >= deadline
						return { usage: response.usage, response, wrapUp, expired, spent }
					})
					const attempt = yield* Effect.result(
						health.run(request.model, turn).pipe(
							Effect.timeoutOrElse({
								duration: Math.max(0, hardDeadline - queuedAt),
								orElse: () =>
									Effect.fail(
										new LoopError({ reason: 'agent ran past its wall time' })
									),
							})
						)
					)
					if (Result.isFailure(attempt)) {
						const error = attempt.failure
						// Unparseable tool arguments fail the turn before the chat records it.
						if (
							error._tag === 'LlmError' &&
							error.reason === 'ToolParameterValidationError'
						)
							return yield* correct(state, [
								...state.pending,
								toUserMessage(
									'Your last tool call arguments were not valid JSON. Call the tool again.'
								),
							])
						return yield* Effect.fail(error)
					}
					const { response, wrapUp, expired, spent } = attempt.success
					const inputTokens = response.usage.inputTokens.total ?? 0
					const outputTokens = response.usage.outputTokens.total ?? 0
					const firstMessageTokens = state.firstMessageTokens ?? inputTokens
					if (request.source !== undefined)
						yield* ledger.recordTurn(request.source, {
							usage: response.usage,
							// A finish-only turn sends fewer tool definitions than the first call did.
							firstMessageTokens: Math.min(firstMessageTokens, inputTokens),
							first: state.firstMessageTokens === undefined,
						})
					yield* tokens.record(inputTokens + outputTokens)
					if (state.firstMessageTokens === undefined)
						yield* tokens.applyRate(inputTokens, firstEstimate)
					const sent = {
						...state,
						wrapUpSent: state.wrapUpSent || wrapUp,
						firstMessageTokens,
						spentTokens: state.spentTokens + inputTokens + outputTokens,
						nextInputTokens: inputTokens + outputTokens,
						...toBudgetMark(state.budgetForced, spent),
					}
					const calls: readonly ToolCall[] = response.toolCalls
					const finishCall = calls.find(call => call.name === finish)
					if (finishCall || calls.length === 0) {
						const answer = finishCall
							? finishCall.params
							: parseAnswerJson(response.text)
						const parsed = yield* Effect.result(
							answer === undefined
								? Effect.fail({ message: 'the answer is not valid JSON' })
								: request.parse(answer)
						)
						const reply = (toolText: string, userText: string) =>
							finishCall
								? toToolMessage(
										calls,
										calls.map(call =>
											call === finishCall ? toolText : 'skipped'
										)
									)
								: toUserMessage(userText)
						if (Result.isSuccess(parsed))
							return yield* accept(
								{
									value: parsed.success,
									toolCalls: state.toolCalls,
									turns: state.turn,
									spentTokens: sent.spentTokens,
									unspentTokens: 0,
									...(sent.budgetForced ? { budgetStopped: true } : {}),
								},
								{ ...sent, turn: state.turn + 1 },
								text => reply(text, text)
							)
						const problem = parsed.failure.message
						return yield* correct(sent, [
							reply(
								`error: ${problem}. Call ${finish} again.`,
								`Call the ${finish} tool with your answer (${problem}).`
							),
						])
					}
					const results = yield* resolveCalls(
						calls,
						state,
						wrapUp || expired,
						yield* Clock.currentTimeMillis
					)
					const refusal = `error: token budget reached; call ${finish} now`
					const outputs = results.map(({ output }) =>
						fenceData(TOOL_OUTPUT_LABEL, output)
					)
					yield* tokens.claimFor(sent, toEstimatedTokens(outputs.join('')))
					const fenced = toAffordableOutputs(
						outputs,
						yield* tokens.current,
						sent,
						refusal
					)
					// Only an output the model receives counts as read.
					const shown = calls.map((call, index) =>
						fenced[index] === refusal
							? { call, output: refusal }
							: { call, output: '', ...results[index] }
					)
					yield* Ref.update(received, reads =>
						shown.reduce(addToolReads, reads)
					)
					if (request.onToolOutputs) yield* request.onToolOutputs(shown)
					const message = toToolMessage(calls, fenced)
					const next = {
						...sent,
						nextInputTokens:
							sent.nextInputTokens + toEstimatedTokens(fenced.join('')),
						toolCalls: state.toolCalls + calls.length,
						turn: state.turn + 1,
						pending: [message],
					}
					if (!wrapUp) return yield* step(next)
					if (state.corrections >= MAX_CORRECTIONS)
						return yield* new LoopError({
							reason: `agent did not call ${finish} after its tool budget ran out`,
						})
					return yield* step({ ...next, corrections: state.corrections + 1 })
				})

			// A continuation that fails keeps the answer that came before it.
			return yield* step({
				toolCalls: 0,
				corrections: 0,
				wrapUpSent: false,
				turn: 1,
				pending: [],
				spentTokens: 0,
				nextInputTokens: firstEstimate,
			}).pipe(
				Effect.catch(error =>
					Effect.flatMap(Ref.get(kept), first =>
						first ? Effect.succeed(first) : Effect.fail(error)
					)
				),
				Effect.flatMap(tokens.settle)
			)
		})

		return { run }
	})
)
