import {
	type EvidenceRef,
	getIntentionalLimit,
	getLineCount,
	getValidatorChoices,
	isEvidenceInCode,
	parseAddedRanges,
	parseEvidenceRef,
	parseLsTree,
	type PullRequestInfo,
	type ReplyClaim,
	type ReplyDecision,
	type ReplyItem,
	toReplyDecision,
	type Validation,
} from '@mng-review/domain'
import { Context, Effect, Layer, Option, Ref } from 'effect'
import type { Rules } from '../../../platform/config/rules.service'
import { SAFE_DIFF } from '../../../platform/git/git.constants'
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
	BINARY_DIFF,
	MAX_EVIDENCE_CHECKED,
	MAX_REPLY_CHARS,
	NO_MODEL_LEFT,
	REPLY_SOURCE,
	SYMLINK_MODE,
} from '../domain/reply.constants'
import { getShownKeys, isRangeRead } from './reply-read.helper'
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
 * the reply; an `intentional` claim's evidence is checked in git. `toReplyDecision` then decides. A
 * failure of the model, git or the token budget leaves the reply `seen`; the service never fails.
 * Runs inside `limits.tokens_per_run` on the job's ledger.
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
					`${finding.path} at head, lines around the finding (read more with read_file):`,
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

		/** True when a commit since the thread's commit changed the finding's file. */
		const hasCommitSince = Effect.fn('ReplyService.hasCommitSince')(function* (
			item: ReplyItem,
			headRef: string
		) {
			const args = [
				'diff',
				'--quiet',
				...SAFE_DIFF,
				item.base,
				headRef,
				'--',
				item.finding.path,
			]
			const result = yield* git.exec(args)
			if (result.exitCode > 1)
				return yield* new GitError({
					args,
					exitCode: result.exitCode,
					stderr: result.stderr,
				})
			return result.exitCode === 1
		})

		/** The validator's answer at the head; `undefined` when the re-check checked nothing. */
		const recheck = Effect.fn('ReplyService.recheck')(function* (
			item: ReplyItem,
			request: ReplyRequest
		) {
			const report = yield* rechecker.recheck({
				rules: request.rules,
				headRef: request.headRef,
				pr: request.pr,
				items: [{ finding: item.finding, base: item.base }],
			})
			return report.results[0]?.validation
		})

		/** The head's tree entry for a path, for its mode. */
		const readHeadEntry = Effect.fn('ReplyService.readHeadEntry')(function* (
			change: RepoScope['change'],
			path: string
		) {
			const args = [
				'ls-tree',
				'-z',
				'--full-tree',
				change.head.commit,
				'--',
				path,
			]
			const result = yield* git.exec(args)
			if (result.exitCode !== 0)
				return yield* new GitError({
					args,
					exitCode: result.exitCode,
					stderr: result.stderr,
				})
			return parseLsTree(result.stdout).find(entry => entry.name === path)
		})

		/**
		 * True when the classifier was shown every cited line and they are code that exists and that
		 * the pull request did not add. A symlink at the head, a file whose text holds a NUL, and a
		 * diff git prints as binary (a binary file or one marked `-diff`, which shows no added lines)
		 * never pass.
		 */
		const isInCode = Effect.fn('ReplyService.isInCode')(function* (
			ref: EvidenceRef,
			scope: RepoScope,
			reads: ReadonlySet<string>
		) {
			const { change } = scope
			const args = [
				'diff',
				'-U0',
				...SAFE_DIFF,
				change.mergeBase,
				change.head.commit,
				'--',
				ref.path,
			]
			const [entry, head, base, diff] = yield* Effect.all(
				[
					readHeadEntry(change, ref.path),
					git.readFileAt(change.head.commit, ref.path),
					git.readFileAt(change.mergeBase, ref.path),
					git.exec(args),
				],
				{ concurrency: 4 }
			)
			if (diff.exitCode !== 0)
				return yield* new GitError({
					args,
					exitCode: diff.exitCode,
					stderr: diff.stderr,
				})
			if (entry?.mode === SYMLINK_MODE || BINARY_DIFF.test(diff.stdout))
				return false
			if ((head ?? base)?.includes('\0')) return false
			if (!isRangeRead(reads, head === undefined ? 'base' : 'head', ref))
				return false
			return isEvidenceInCode(ref, {
				headLines: head === undefined ? undefined : getLineCount(head),
				baseLines: base === undefined ? undefined : getLineCount(base),
				added: parseAddedRanges(diff.stdout),
			})
		})

		/** The evidence entries that pass `isInCode`; entries that are not `path:line` never do. */
		const getCheckedEvidence = (
			claim: ReplyClaim,
			scope: RepoScope,
			reads: ReadonlySet<string>
		) =>
			Effect.filter(claim.evidence.slice(0, MAX_EVIDENCE_CHECKED), entry => {
				const ref = parseEvidenceRef(entry)
				return ref ? isInCode(ref, scope, reads) : Effect.succeed(false)
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
				const fixed = claim.claim === 'fixed'
				const commitSince =
					fixed && (yield* hasCommitSince(item, request.headRef))
				const validation: Validation | undefined = commitSince
					? yield* recheck(item, request)
					: undefined
				// An unvalidated re-check is a model or budget failure, not an answer about the code.
				if (validation?.status === 'unvalidated')
					return yield* Effect.fail({ message: validation.error })
				const checkedEvidence =
					claim.claim === 'intentional' && limit === 'ok' && claim.holds
						? yield* getCheckedEvidence(claim, scope, reads)
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
