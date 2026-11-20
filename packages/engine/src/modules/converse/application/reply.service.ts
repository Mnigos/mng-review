import {
	type EvidenceRef,
	formatSchemaIssue,
	getIntentionalLimit,
	getLineCount,
	getValidatorChoices,
	isEvidenceInCode,
	parseAddedRanges,
	parseEvidenceRef,
	type PullRequestInfo,
	type ReplyClaim,
	type ReplyDecision,
	type ReplyItem,
	replyAnswerSchema,
	toReplyClaim,
	toReplyDecision,
	type Validation,
} from '@mng-review/domain'
import { Context, Effect, Layer, Option, Schema } from 'effect'
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
import { AgentLoopService } from '../../review/application/services/agent-loop.service'
import { ModelHealthService } from '../../review/application/services/model-health.service'
import {
	type RepoScope,
	RepoToolsService,
} from '../../review/application/services/repo-tools.service'
import { RecheckService } from '../../validation/application/recheck.service'
import { REPLY_PROMPT } from './reply.prompt'
import { ReportReplyTool } from './report-reply.tool'

/** Attempts per reply before it counts as unclear. */
export const REPLY_ATTEMPTS = 2
/** Evidence entries the engine checks per reply; the rest are ignored. */
const MAX_EVIDENCE_CHECKED = 10
/** Characters of the finding's file the classifier gets in its first message. */
const MAX_FILE_CHARS = 20_000
/** Lines before and after the finding's line the classifier gets in its first message. */
const FILE_WINDOW_LINES = 80
const NO_MODEL_LEFT = 'no validator model left'
/** The classifiers' line in the run's tokens by source. */
const REPLY_SOURCE = 'reply'

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

/** Reads a `report_reply` answer; the schema's reasons go back to the model. */
function parseReplyAnswer(answer: unknown) {
	return Schema.decodeUnknownEffect(replyAnswerSchema)(answer).pipe(
		Effect.map(toReplyClaim),
		Effect.mapError(error => ({ message: formatSchemaIssue(error.issue) }))
	)
}

/** The `read_file` range around a finding's line. */
function toFileWindow(line: number): string {
	return `${Math.max(1, line - FILE_WINDOW_LINES)}-${line + FILE_WINDOW_LINES}`
}

/** Why a classifier attempt gave no claim: a loop or model failure, or no model left. */
interface AttemptFailure {
	readonly _tag?: string
	readonly message: string
}

/** True when a failure must not be tried again: no model left or the run's tokens spent. */
function isFinal(error: AttemptFailure): boolean {
	return error.message === NO_MODEL_LEFT || error._tag === 'TokenBudgetError'
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

		const toUserMessage = Effect.fn('ReplyService.toUserMessage')(function* (
			item: ReplyItem,
			scope: RepoScope
		) {
			const { finding } = item
			const file = yield* repoTools.call(scope, ReadFileTool.name, {
				ref: 'head',
				path: finding.path,
				range: toFileWindow(finding.line),
			})
			const reported = {
				path: finding.path,
				line: finding.line,
				severity: finding.severity,
				title: finding.title,
				trigger: finding.trigger,
				impact: finding.impact,
				evidence: finding.evidence,
			}
			return [
				fenceData('The finding:', JSON.stringify(reported, null, 2)),
				fenceData(
					`${finding.path} at head, lines around the finding (read more with read_file):`,
					truncateText(file, MAX_FILE_CHARS)
				),
				fenceData("The author's reply, a claim to test:", item.reply),
			].join('\n\n')
		})

		/** One classifier conversation on the first validator model still available. */
		const attempt = (
			item: ReplyItem,
			scope: RepoScope,
			request: ReplyRequest,
			user: string
		) =>
			Effect.gen(function* () {
				const dropped = yield* health.dropped
				const model = getValidatorChoices(
					item.finding,
					request.rules.config
				).find(entry => !dropped.some(drop => drop.model === entry.model))
				if (!model) return yield* Effect.fail({ message: NO_MODEL_LEFT })
				const { value } = yield* loop.run({
					model,
					system: REPLY_PROMPT,
					user,
					scope,
					tools: VALIDATOR_REPO_TOOLS,
					finish: ReportReplyTool.name,
					parse: parseReplyAnswer,
					source: REPLY_SOURCE,
				})
				return value
			})

		const classify = Effect.fn('ReplyService.classify')(function* (
			item: ReplyItem,
			scope: RepoScope,
			request: ReplyRequest
		) {
			const user = yield* toUserMessage(item, scope)
			return yield* attempt(item, scope, request, user).pipe(
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

		/** True when the entry points at code that exists and that the pull request did not add. */
		const isInCode = Effect.fn('ReplyService.isInCode')(function* (
			ref: EvidenceRef,
			scope: RepoScope
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
			const [head, base, diff] = yield* Effect.all(
				[
					git.readFileAt(change.head.commit, ref.path),
					git.readFileAt(change.mergeBase, ref.path),
					git.exec(args),
				],
				{ concurrency: 3 }
			)
			if (diff.exitCode !== 0)
				return yield* new GitError({
					args,
					exitCode: diff.exitCode,
					stderr: diff.stderr,
				})
			return isEvidenceInCode(ref, {
				headLines: head === undefined ? undefined : getLineCount(head),
				baseLines: base === undefined ? undefined : getLineCount(base),
				added: parseAddedRanges(diff.stdout),
			})
		})

		/** True when at least one evidence entry passes; entries that are not `path:line` never do. */
		const hasCheckedEvidence = (claim: ReplyClaim, scope: RepoScope) =>
			Effect.findFirst(
				claim.evidence
					.slice(0, MAX_EVIDENCE_CHECKED)
					.flatMap(entry => parseEvidenceRef(entry) ?? []),
				ref => isInCode(ref, scope)
			).pipe(Effect.map(Option.isSome))

		const decideItem = (
			item: ReplyItem,
			scope: RepoScope,
			request: ReplyRequest
		) =>
			Effect.gen(function* () {
				const { config } = request.rules
				const claim = yield* classify(item, scope, request)
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
				const evidenceChecked =
					claim.claim === 'intentional' &&
					limit === 'ok' &&
					claim.holds === true &&
					(yield* hasCheckedEvidence(claim, scope))
				const decision = toReplyDecision({
					item,
					claim,
					config,
					limit,
					evidenceChecked,
					commitSince,
					...(validation ? { recheck: validation } : {}),
				})
				return { ...item, decision } satisfies DecidedReply
			}).pipe(
				Effect.catch(error =>
					Effect.succeed<DecidedReply>({
						...item,
						decision: { action: 'seen' },
						error: error.message,
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
