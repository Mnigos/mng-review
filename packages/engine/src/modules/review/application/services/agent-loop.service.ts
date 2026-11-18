import type { ModelSetting } from '@mng-review/domain'
import { Clock, Context, Duration, Effect, Layer, Result } from 'effect'
import { Chat, type Prompt, type Response, Toolkit } from 'effect/ai'
import { fenceData } from '../../../../utils/fence.util'
import {
	MAX_CORRECTIONS,
	TOOL_OUTPUT_LABEL,
	WRAP_UP_GRACE,
} from '../../domain/review.constants'
import { LoopError } from '../../domain/review.errors'
import { parseAnswerJson } from '../../infrastructure/answer-json.parser'
import { REPO_TOOLS, type RepoToolName } from '../repo.toolkit'
import { ReportFindingsTool } from '../report-findings.tool'
import { ReportVerdictTool } from '../report-verdict.tool'
import { ReviewLimits } from '../review-limits.context'
import { type ModelCallError, ModelHealthService } from './model-health.service'
import { type RepoScope, RepoToolsService } from './repo-tools.service'

/** Every tool an agent can be offered; each run picks its own with `toolChoice.oneOf`. */
const AGENT_TOOLKIT = Toolkit.make(
	...REPO_TOOLS,
	ReportFindingsTool,
	ReportVerdictTool
)
export type FinishToolName =
	| typeof ReportFindingsTool.name
	| typeof ReportVerdictTool.name

/** A problem with an answer, told back to the model. */
interface AnswerProblem {
	readonly message: string
}

/** One agent run: its prompts, its model, the tools it may call and how its answer is read. */
export interface LoopRequest<TValue> {
	readonly model: ModelSetting
	readonly system: string
	readonly user: string
	readonly scope: RepoScope
	/** Repository tools this agent may call. */
	readonly tools: readonly RepoToolName[]
	/** The tool the agent calls once with its answer. */
	readonly finish: FinishToolName
	/** Reads the finish tool's arguments or a plain JSON answer. */
	readonly parse: (answer: unknown) => Effect.Effect<TValue, AnswerProblem>
}

/** An agent's answer and what it took. */
export interface LoopResult<TValue> {
	readonly value: TValue
	readonly toolCalls: number
	readonly turns: number
}

/** Where a loop stands between turns. */
interface LoopState {
	readonly toolCalls: number
	readonly corrections: number
	readonly wrapUpSent: boolean
	readonly turn: number
	/** Messages the next turn sends: tool results and corrections. */
	readonly pending: readonly Prompt.MessageEncoded[]
}

type ToolCall = Response.ToolCallPart<string, unknown>

/** A tool message answering every call of a turn with its text, in order. */
function toToolMessage(
	calls: readonly ToolCall[],
	outputs: readonly string[]
): Prompt.MessageEncoded {
	return {
		role: 'tool',
		content: calls.map((call, index) => ({
			type: 'tool-result',
			id: call.id,
			name: call.name,
			isFailure: false,
			result: outputs[index] ?? '',
			providerExecuted: false,
		})),
	}
}

/** A user message. */
function toUserMessage(content: string): Prompt.MessageEncoded {
	return { role: 'user', content }
}

/**
 * Runs one agent as a tool loop on `effect/ai` `Chat`: one model call per turn, the turn's tool
 * calls resolved in parallel by the loop, until the agent calls its finish tool or answers with
 * plain JSON. Tool calls are bounded by `maxToolCalls` (calls in one turn never exceed what is
 * left), wall time by `maxWallTime`; past either, the agent gets only the finish tool and is told to
 * answer. Repository calls a model returns after the wall time are refused. Every model call,
 * corrections included, ends by one fixed deadline: the wall time plus one grace period. An invalid answer gets a correction
 * turn; after `MAX_CORRECTIONS` the agent fails with a `LoopError`.
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
			const deadline = (yield* Clock.currentTimeMillis) + wallMillis
			const hardDeadline = deadline + graceMillis

			const correct = (state: LoopState, pending: Prompt.MessageEncoded[]) => {
				if (state.corrections >= MAX_CORRECTIONS)
					return Effect.fail(
						new LoopError({ reason: `agent gave no valid ${finish} answer` })
					)
				return step({
					...state,
					corrections: state.corrections + 1,
					turn: state.turn + 1,
					pending,
				})
			}

			/**
			 * Runs the turn's repository calls; the first calls up to the allowance run, the rest get an
			 * error. Each call ends at the wall deadline with an error result, so a stalled git process
			 * cannot hold the agent and the grace period stays free for the finish answer.
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
							return Effect.succeed(`error: tool ${call.name} is not available`)
						if (!runnable.has(call.id))
							return Effect.succeed(
								`error: tool call limit reached; call ${finish}`
							)
						return repoTools.call(request.scope, call.name, call.params).pipe(
							Effect.timeoutOrElse({
								duration: Math.max(0, deadline - now),
								orElse: () =>
									Effect.succeed(
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
						const wrapUp =
							state.toolCalls >= limits.maxToolCalls || now >= deadline
						const prompt = [
							...state.pending,
							...(wrapUp && !state.wrapUpSent
								? [
										toUserMessage(
											`You have used up your tool calls or time. Call ${finish} now with what you have.`
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
						return { usage: response.usage, response, wrapUp, expired }
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
					const { response, wrapUp, expired } = attempt.success
					const sent = { ...state, wrapUpSent: state.wrapUpSent || wrapUp }
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
						if (Result.isSuccess(parsed))
							return {
								value: parsed.success,
								toolCalls: state.toolCalls,
								turns: state.turn,
							}
						const problem = parsed.failure.message
						return yield* correct(
							sent,
							finishCall
								? [
										toToolMessage(
											calls,
											calls.map(call =>
												call === finishCall
													? `error: ${problem}. Call ${finish} again.`
													: 'skipped'
											)
										),
									]
								: [
										toUserMessage(
											`Call the ${finish} tool with your answer (${problem}).`
										),
									]
						)
					}
					const outputs = yield* resolveCalls(
						calls,
						state,
						wrapUp || expired,
						yield* Clock.currentTimeMillis
					)
					const message = toToolMessage(
						calls,
						outputs.map(output => fenceData(TOOL_OUTPUT_LABEL, output))
					)
					const next = {
						...sent,
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

			return yield* step({
				toolCalls: 0,
				corrections: 0,
				wrapUpSent: false,
				turn: 1,
				pending: [],
			})
		})

		return { run }
	})
)
