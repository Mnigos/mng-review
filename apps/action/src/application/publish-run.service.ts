import { RulesService } from '@mng-review/engine'
import {
	type PublishResult,
	PublishService,
	type StatusReportResult,
	StatusReportService,
	toTrustedPlacement,
} from '@mng-review/github'
import { Context, Effect, Layer } from 'effect'
import type { OutcomeFile } from '../infrastructure/outcome-file.schema'

/**
 * What publishing trusts besides the outcome file: which engine posts, named in every marker, and
 * the pull request and head from the runner and the event, which the file's binding was checked
 * against.
 */
export interface PublishContext {
	readonly engineCommit: string | undefined
	readonly pullNumber: number
	readonly head: string
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
			/** `false` when an existing summary comment was kept as it was. */
			readonly posted: boolean
	  }
	| { readonly status: 'not-published'; readonly reason: string }
	| { readonly status: 'failed'; readonly reason: string }

/**
 * Publishes a parsed outcome file on its pull request: a reviewed run gets threads, the sticky
 * summary, a check run per agent and the `MNG Review` commit status, also when no finder had to
 * run (the re-check's proposals and the status still matter); an offline endpoint gets the
 * summary when there is none and an `error` status. A skip, an invalid configuration or a git
 * failure posts nothing; the job summary and the job's exit code report them. The rules are
 * loaded again from the binding's base commit, never taken from the file, and no model is
 * called. A GitHub or rules failure never fails the job: the report says what happened.
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
		const statuses = yield* StatusReportService
		const rulesService = yield* RulesService

		const publish = Effect.fn('PublishRunService.publish')(function* (
			outcome: OutcomeFile,
			context: PublishContext
		) {
			const { report, recheck } = outcome
			if (outcome.status === 'reviewed' && report) {
				if (report.planReport.plan.skippedRun)
					return {
						status: 'not-published',
						reason: report.planReport.plan.skippedRun,
					} satisfies PublishReport
				const rules = yield* rulesService.load(outcome.binding.baseSha)
				const placed = toTrustedPlacement(report, rules)
				const result = yield* publisher.publish({
					pullNumber: context.pullNumber,
					report: placed,
					rules,
					head: context.head,
					engineCommit: context.engineCommit,
					...(recheck
						? {
								recheck: {
									checked: recheck.checked,
									proposals: recheck.rejected,
									tokens: recheck.tokens,
								},
							}
						: {}),
				})
				const checks = yield* statuses.report({
					head: context.head,
					report: placed,
					verdict: result.verdict,
					openBugs: result.openBugs,
				})
				return { status: 'published', result, checks } satisfies PublishReport
			}
			if (outcome.status === 'offline') {
				const reason = `Reviewer offline: ${outcome.reason ?? 'no reason given'}. Nothing was reviewed.`
				const posted = yield* publisher.publishStatus({
					pullNumber: context.pullNumber,
					status: reason,
					head: context.head,
					engineCommit: context.engineCommit,
				})
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
