import { RulesService } from '@mng-review/engine'
import {
	type CommandRun,
	GitHubConfig,
	provideOwnedIdentities,
	type PublishResult,
	PublishService,
	type ReplyPublishResult,
	ReplyPublishService,
	type StatusReportResult,
	StatusReportService,
	SummaryReviewService,
	toTrustedPlacement,
} from '@mng-review/github'
import { Context, Effect, Layer } from 'effect'
import type { OutcomeFile } from '../infrastructure/outcome-file.schema'
import { getGateReason } from './run-gate.helper'
import type { PullRequestEvent } from './shadow-run.types'

/**
 * What publishing trusts besides the outcome file: which engine posts, named in every marker, and
 * the pull request and head from the runner and the event, which the file's binding was checked
 * against.
 */
export interface PublishContext {
	readonly engineCommit: string | undefined
	readonly pullNumber: number
	readonly head: string
	/**
	 * The pull request as this job's own event payload gives it, or for a command as read again
	 * from the API, for the base rules' gates.
	 */
	readonly event: Pick<PullRequestEvent, 'action' | 'pr'>
	/** Set for a command run, from the job's trusted context; never from the outcome file. */
	readonly command?: CommandRun
	/** A reply schedule run, from the job's trusted trigger: only a replied outcome publishes. */
	readonly converse?: boolean
}

/** What publishing did with an outcome. */
export type PublishReport =
	| {
			readonly status: 'published'
			readonly result: PublishResult
			/** Check runs written and whether the commit status was set. */
			readonly checks: StatusReportResult
	  }
	| {
			readonly status: 'status-only'
			readonly reason: string
			/** `false` when an existing summary review was edited instead of a new one posted. */
			readonly posted: boolean
	  }
	| {
			readonly status: 'replied'
			readonly result: ReplyPublishResult
	  }
	| { readonly status: 'not-published'; readonly reason: string }
	| { readonly status: 'failed'; readonly reason: string }

/**
 * Publishes a parsed outcome file on its pull request: a reviewed run gets threads, the summary
 * review, a check run per agent and the `MNG Review` commit status, also when no finder had to
 * run (the re-check's proposals and the status still matter); an offline endpoint gets the
 * summary when there is none and an `error` status; a reply schedule run gets its answers
 * (`ReplyPublishService`) and nothing else. The rules name the bot identities whose
 * earlier threads and summary count. A skip, an invalid configuration or a git failure posts nothing; the job summary and the job's exit code report them. The rules are
 * loaded again from the binding's base commit, never taken from the file, and no model is
 * called. A GitHub or rules failure never fails the job: the report says what happened. When the
 * summary write fails after threads may have been posted, the status is set to `error` first.
 */
export class PublishRunService extends Context.Service<
	PublishRunService,
	{
		readonly run: (
			outcome: OutcomeFile,
			context: PublishContext
		) => Effect.Effect<PublishReport>
	}
>()('mng-review/PublishRunService') {}

export const PublishRunServiceLive = Layer.effect(
	PublishRunService,
	Effect.gen(function* () {
		const publisher = yield* PublishService
		const summaries = yield* SummaryReviewService
		const statuses = yield* StatusReportService
		const replyPublisher = yield* ReplyPublishService
		const rulesService = yield* RulesService
		const { identity } = yield* GitHubConfig

		/**
		 * A reply schedule run: the decisions only, with no `skip` rule or run limit, since a reply
		 * on a pull request with a skip label is still the author's question.
		 */
		const publishReplies = Effect.fn('PublishRunService.publishReplies')(
			function* (outcome: OutcomeFile, context: PublishContext) {
				if (
					!context.converse ||
					outcome.status !== 'replied' ||
					!outcome.replies
				)
					return {
						status: 'not-published',
						reason: `the run ended ${outcome.status}`,
					} satisfies PublishReport
				const rules = yield* rulesService.load(outcome.binding.baseSha)
				const result = yield* replyPublisher
					.publish({
						pullNumber: context.pullNumber,
						head: context.head,
						engineCommit: context.engineCommit,
						rules,
						replies: {
							decisions: outcome.replies.decided,
							base: outcome.binding.baseSha,
							tokens: outcome.replies.tokens,
						},
					})
					.pipe(
						provideOwnedIdentities(identity, rules.config.identity.previous)
					)
				return { status: 'replied', result } satisfies PublishReport
			}
		)

		const publish = Effect.fn('PublishRunService.publish')(function* (
			outcome: OutcomeFile,
			context: PublishContext
		) {
			const { report, recheck, replies } = outcome
			if (context.converse || outcome.status === 'replied')
				return yield* publishReplies(outcome, context)
			if (outcome.status !== 'reviewed' && outcome.status !== 'offline')
				return {
					status: 'not-published',
					reason: `the run ended ${outcome.status}`,
				} satisfies PublishReport
			// The review job decided the gates too, but a file never decides whether this job writes.
			const rules = yield* rulesService.load(outcome.binding.baseSha)
			const owned = provideOwnedIdentities(
				identity,
				rules.config.identity.previous
			)
			const gated = getGateReason(
				context.event,
				rules.config,
				yield* summaries.readPrior(context.pullNumber).pipe(owned)
			)
			if (gated !== undefined)
				return {
					status: 'not-published',
					reason: gated,
				} satisfies PublishReport
			if (outcome.status === 'reviewed' && report) {
				if (report.planReport.plan.skippedRun)
					return {
						status: 'not-published',
						reason: report.planReport.plan.skippedRun,
					} satisfies PublishReport
				const placed = toTrustedPlacement(report, rules)
				const result = yield* publisher
					.publish({
						pullNumber: context.pullNumber,
						report: placed,
						rules,
						head: context.head,
						engineCommit: context.engineCommit,
						...(context.command ? { command: context.command } : {}),
						...(recheck
							? {
									recheck: {
										checked: recheck.checked,
										proposals: recheck.rejected,
										tokens: recheck.tokens,
									},
								}
							: {}),
						...(replies
							? {
									replies: {
										decisions: replies.decided,
										base: outcome.binding.baseSha,
										tokens: replies.tokens,
									},
								}
							: {}),
					})
					.pipe(
						owned,
						Effect.tapErrorTag('PublishIncompleteError', () =>
							statuses.reportUnfinished(context.head)
						)
					)
				const checks = yield* statuses.report({
					head: context.head,
					report: placed,
					verdict: result.verdict,
					openBugs: result.openBugs,
					finished: result.finished,
				})
				return { status: 'published', result, checks } satisfies PublishReport
			}
			if (outcome.status === 'offline') {
				const reason = `Reviewer offline: ${outcome.reason ?? 'no reason given'}. Nothing was reviewed.`
				const posted = yield* summaries
					.publishStatus({
						pullNumber: context.pullNumber,
						status: reason,
						head: context.head,
						engineCommit: context.engineCommit,
					})
					.pipe(owned)
				yield* statuses.reportOffline(context.head)
				return { status: 'status-only', reason, posted } satisfies PublishReport
			}
			return {
				status: 'not-published',
				reason: `the run ended ${outcome.status}`,
			} satisfies PublishReport
		})

		const run = Effect.fn('PublishRunService.run')(function* (
			outcome: OutcomeFile,
			context: PublishContext
		) {
			return yield* publish(outcome, context).pipe(
				Effect.catchTags({
					GitHubApiError: error =>
						Effect.succeed({
							status: 'failed',
							reason: error.message,
						} satisfies PublishReport),
					PublishIncompleteError: error =>
						Effect.succeed({
							status: 'failed',
							reason: error.message,
						} satisfies PublishReport),
					ConfigError: error =>
						Effect.succeed({
							status: 'failed',
							reason: `the rules at the base commit: ${error.source}: ${error.reason}`,
						} satisfies PublishReport),
					GitError: error =>
						Effect.succeed({
							status: 'failed',
							reason: `the rules at the base commit: git: ${error.message}`,
						} satisfies PublishReport),
				})
			)
		})

		return { run }
	})
)
