import {
	getIntentionalLimit,
	getValidatorChoices,
	type PullRequestInfo,
	type ReplyDecision,
	type ReplyItem,
	toReplyDecision,
	type Validation,
} from '@mng-review/domain'
import { Context, Effect, Layer, Option, Ref } from 'effect'
import type { Rules } from '../../../platform/config/rules.service'
import { GitError } from '../../../platform/git/git.errors'
import { GitService } from '../../../platform/git/git.service'
import {
	type TokensByModel,
	TokenLedger,
} from '../../../platform/llm/token-ledger.service'
import { fenceData, truncateText } from '../../../utils/fence.util'
import {
	ReadFileTool,
	VALIDATOR_REPO_TOOLS,
} from '../../review/application/repo.toolkit'
import { ReportReplyTool } from '../../review/application/report-reply.tool'
import { AgentLoopService } from '../../review/application/services/agent-loop.service'
import { ModelHealthService } from '../../review/application/services/model-health.service'
import {
	type RepoScope,
	RepoToolsService,
} from '../../review/application/services/repo-tools.service'
import { RecheckService } from '../../validation/application/recheck.service'
import {
	type Classified,
	isFinal,
	parseReplyAnswer,
	toCauseMessage,
	toFileWindow,
	toReportedFinding,
} from '../domain/reply-attempt.helper'
import {
	MAX_REPLY_CHARS,
	NO_MODEL_LEFT,
	RECHECK_FAILED,
	REPLY_SOURCE,
} from '../domain/reply.constants'
import { ReplyEvidenceService } from './reply-evidence.service'
import { getShownKeys } from './reply-read.helper'
import { REPLY_PROMPT } from './reply.prompt'

/** Attempts per reply before it counts as unclear. */
export const REPLY_ATTEMPTS = 2

/** Replies in the bot's threads of one pull request, to decide on at one head. */
export interface ReplyRequest {
	readonly rules: Rules
	readonly headRef: string
	/** The merge base of the pull request at the head; evidence counts only outside what it added. */
	readonly mergeBase: string
	readonly pr: PullRequestInfo
	readonly items: readonly ReplyItem[]
}

/** A reply with what the bot does with it. */
export interface DecidedReply extends ReplyItem {
	readonly decision: ReplyDecision
	/** Why the reply is only `seen`: the model, git or the token budget failed. */
	readonly error?: string
}

/** Each reply with its decision, in the request's order. */
export interface ReplyReport {
	readonly results: readonly DecidedReply[]
	/** Tokens the whole job spent so far, these decisions included. */
	readonly tokens: TokensByModel
}

/**
 * Decides on authors' replies in the bot's threads. Per reply, a fresh agent on a validator model
 * reads the claim (`fixed`, `intentional` or `unclear`) with the reply as fenced data; a `fixed`
 * claim is checked by the validator's re-check over the change since the thread's commit, without
 * the reply; an `intentional` claim's evidence is checked in git by `ReplyEvidenceService`.
 * `toReplyDecision` then decides, every reply at the head commit `decide` resolved once. A failure
 * of the model, git or the token budget leaves the reply `seen`; the service never fails. Runs
 * inside `limits.tokens_per_run` on the job's ledger.
 */
export class ReplyService extends Context.Service<
	ReplyService,
	{
		readonly decide: (request: ReplyRequest) => Effect.Effect<ReplyReport>
	}
>()('mng-review/ReplyService') {}

export const ReplyServiceLive = Layer.effect(
	ReplyService,
	Effect.gen(function* () {
		const loop = yield* AgentLoopService
		const health = yield* ModelHealthService
		const repoTools = yield* RepoToolsService
		const git = yield* GitService
		const ledger = yield* TokenLedger
		const rechecker = yield* RecheckService
		const evidence = yield* ReplyEvidenceService

		/**
		 * The classifier's first message and the keys of the window lines it holds whole; a line the
		 * tool's output limit cut inside counts as unread.
		 */
		const toUserMessage = Effect.fn('ReplyService.toUserMessage')(function* (
			item: ReplyItem,
			scope: RepoScope
		) {
			const { finding } = item
			const file = yield* repoTools.run(scope, ReadFileTool.name, {
				ref: 'head',
				path: finding.path,
				range: toFileWindow(finding.line),
			})
			const user = [
				fenceData(
					'The finding:',
					JSON.stringify(toReportedFinding(finding), null, 2)
				),
				fenceData(
					"The finding's file at head, lines around it (read more with read_file):",
					file.output
				),
				fenceData(
					"The author's reply, a claim to test:",
					truncateText(item.reply, MAX_REPLY_CHARS)
				),
			].join('\n\n')
			return { user, window: file.shown ? getShownKeys(file.shown) : [] }
		})

		/**
		 * One classifier conversation on the first validator model still available, with the lines
		 * it was shown whole: the first message's window and its `read_file` calls whose output was
		 * not cut. `grep` and `blame` output shows lines too, but the repository shapes its text, so
		 * it is never evidence that a line was read.
		 */
		const attempt = (
			item: ReplyItem,
			scope: RepoScope,
			request: ReplyRequest,
			message: Effect.Success<ReturnType<typeof toUserMessage>>
		) =>
			Effect.gen(function* () {
				const reads = yield* Ref.make<ReadonlySet<string>>(
					new Set(message.window)
				)
				const dropped = yield* health.dropped
				const model = getValidatorChoices(
					item.finding,
					request.rules.config
				).find(entry => !dropped.some(drop => drop.model === entry.model))
				if (!model) return yield* Effect.fail({ message: NO_MODEL_LEFT })
				const { value } = yield* loop.run({
					model,
					system: REPLY_PROMPT,
					user: message.user,
					scope,
					tools: VALIDATOR_REPO_TOOLS,
					finish: ReportReplyTool.name,
					parse: parseReplyAnswer,
					source: REPLY_SOURCE,
					onToolOutputs: outputs =>
						Ref.update(reads, keys => {
							const read = outputs.flatMap(({ shown }) =>
								shown && !shown.truncated ? getShownKeys(shown) : []
							)
							return new Set([...keys, ...read])
						}),
				})
				return {
					claim: value,
					reads: yield* Ref.get(reads),
				} satisfies Classified
			})

		const classify = Effect.fn('ReplyService.classify')(function* (
			item: ReplyItem,
			scope: RepoScope,
			request: ReplyRequest
		) {
			const message = yield* toUserMessage(item, scope)
			return yield* attempt(item, scope, request, message).pipe(
				Effect.retry({
					times: REPLY_ATTEMPTS - 1,
					while: error => !isFinal(error),
				})
			)
		})

		/**
		 * True when a commit since the thread's commit changed the finding's file, even when a later
		 * one restored it, so the net diff alone would show nothing.
		 */
		const hasCommitSince = Effect.fn('ReplyService.hasCommitSince')(function* (
			item: ReplyItem,
			head: string
		) {
			const args = [
				'log',
				'--full-history',
				'--format=%H',
				'-n',
				'1',
				'--end-of-options',
				`${item.base}..${head}`,
				'--',
				item.finding.path,
			]
			const result = yield* git.exec(args)
			if (result.exitCode !== 0)
				return yield* new GitError({
					args,
					exitCode: result.exitCode,
					stderr: result.stderr,
				})
			return result.stdout.trim() !== ''
		})

		/**
		 * The validator's answer at the head; `undefined` when the thread's commit is no longer an
		 * ancestor of the head, which leaves nothing to check. A re-check that returns no answer for
		 * an ancestor failed, so the reply stays seen.
		 */
		const recheck = Effect.fn('ReplyService.recheck')(function* (
			item: ReplyItem,
			head: string,
			request: ReplyRequest
		) {
			const args = [
				'merge-base',
				'--is-ancestor',
				'--end-of-options',
				item.base,
				head,
			]
			const ancestry = yield* git.exec(args)
			if (ancestry.exitCode === 1) return undefined
			if (ancestry.exitCode !== 0)
				return yield* new GitError({
					args,
					exitCode: ancestry.exitCode,
					stderr: ancestry.stderr,
				})
			const report = yield* rechecker.recheck({
				rules: request.rules,
				headRef: head,
				pr: request.pr,
				items: [{ finding: item.finding, base: item.base }],
			})
			const validation = report.results[0]?.validation
			if (!validation) return yield* Effect.fail({ message: RECHECK_FAILED })
			return validation
		})

		const decideItem = (
			item: ReplyItem,
			scope: RepoScope,
			request: ReplyRequest
		) =>
			Effect.gen(function* () {
				const { config } = request.rules
				const { claim, reads } = yield* classify(item, scope, request)
				const limit = getIntentionalLimit(item.finding, config, scope.change)
				const head = scope.change.head.commit
				const fixed = claim.claim === 'fixed'
				const commitSince = fixed && (yield* hasCommitSince(item, head))
				const validation: Validation | undefined = commitSince
					? yield* recheck(item, head, request)
					: undefined
				// An unvalidated re-check is a model or budget failure, not an answer about the code.
				if (validation?.status === 'unvalidated')
					return yield* Effect.fail({ message: validation.error })
				const checkedEvidence =
					claim.claim === 'intentional' && limit === 'ok' && claim.holds
						? yield* evidence.check(claim, scope, reads)
						: []
				const decision = toReplyDecision({
					item,
					claim,
					config,
					limit,
					checkedEvidence,
					commitSince,
					...(validation ? { recheck: validation } : {}),
				})
				return { ...item, decision } satisfies DecidedReply
			}).pipe(
				// A defect in git or parsing leaves only this reply seen, never the whole run.
				Effect.catchCause(cause =>
					Effect.succeed<DecidedReply>({
						...item,
						decision: { action: 'seen' },
						error: toCauseMessage(cause),
					})
				)
			)

		const decide = Effect.fn('ReplyService.decide')(function* (
			request: ReplyRequest
		) {
			if (request.items.length === 0)
				return {
					results: [],
					tokens: yield* ledger.snapshot,
				} satisfies ReplyReport
			const change = yield* git
				.readChange(request.mergeBase, request.headRef)
				.pipe(Effect.option)
			const results = Option.isNone(change)
				? request.items.map((item): DecidedReply => ({
						...item,
						decision: { action: 'seen' },
						error: 'git could not read the change',
					}))
				: yield* Effect.forEach(
						request.items,
						item =>
							decideItem(
								item,
								{ change: change.value, pr: request.pr },
								request
							),
						{ concurrency: request.rules.config.limits.concurrency }
					)
			return { results, tokens: yield* ledger.snapshot } satisfies ReplyReport
		})

		return { decide }
	})
)
