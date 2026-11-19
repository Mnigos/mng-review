import {
	type PublishResult,
	PublishService,
	type StatusReportResult,
	StatusReportService,
} from '@mng-review/github'
import { Context, Effect, Layer } from 'effect'
import type { ShadowOutcome } from './shadow-run.types'

/** Which engine posts, named in every marker. */
export interface PublishContext {
	readonly engineCommit: string | undefined
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
 * Publishes an outcome on its pull request: a reviewed run gets threads, the sticky summary, a
 * check run per agent and the `MNG Review` commit status, also when no finder had to run (the
 * re-check and the status still matter); an offline endpoint gets the summary when there is none
 * and an `error` status. A skip, an invalid configuration or a git failure posts
 * nothing; the job summary and the job's exit code report them. A GitHub failure never fails the
 * job: the report says what happened.
 */
export class PublishRunService extends Context.Service<
	PublishRunService,
	{
		readonly run: (
			outcome: ShadowOutcome,
			context: PublishContext
		) => Effect.Effect<PublishReport>
	}
>()('mng-review/PublishRunService') {}

export const PublishRunServiceLive = Layer.effect(
	PublishRunService,
	Effect.gen(function* () {
		const publisher = yield* PublishService
		const statuses = yield* StatusReportService

		const publish = Effect.fn('PublishRunService.publish')(function* (
			outcome: ShadowOutcome,
			context: PublishContext
		) {
			if (outcome.status === 'reviewed') {
				const { report, event, rules } = outcome
				if (report.planReport.plan.skippedRun)
					return {
						status: 'not-published',
						reason: report.planReport.plan.skippedRun,
					} satisfies PublishReport
				const result = yield* publisher.publish({
					pullNumber: event.number,
					report,
					rules,
					pr: event.pr,
					head: event.headSha,
					engineCommit: context.engineCommit,
				})
				const checks = yield* statuses.report({
					head: event.headSha,
					report,
					verdict: result.verdict,
					openBugs: result.openBugs,
				})
				return { status: 'published', result, checks } satisfies PublishReport
			}
			if (outcome.status === 'offline') {
				const reason = `Reviewer offline: ${outcome.reason}. Nothing was reviewed.`
				const posted = yield* publisher.publishStatus({
					pullNumber: outcome.event.number,
					status: reason,
					head: outcome.event.headSha,
					engineCommit: context.engineCommit,
				})
				yield* statuses.reportOffline(outcome.event.headSha)
				return { status: 'status-only', reason, posted } satisfies PublishReport
			}
			return {
				status: 'not-published',
				reason: `the run ended ${outcome.status}`,
			} satisfies PublishReport
		})

		const run = Effect.fn('PublishRunService.run')(function* (
			outcome: ShadowOutcome,
			context: PublishContext
		) {
			return yield* publish(outcome, context).pipe(
				Effect.catchTag('GitHubApiError', error =>
					Effect.succeed({
						status: 'failed',
						reason: error.message,
					} satisfies PublishReport)
				)
			)
		})

		return { run }
	})
)
