import { type PublishResult, PublishService } from '@mng-review/github'
import { Context, Effect, Layer } from 'effect'
import type { ShadowOutcome } from './shadow-run.types'

/** Which engine posts, named in every marker. */
export interface PublishContext {
	readonly engineCommit: string | undefined
}

/** What publishing did with an outcome. */
export type PublishReport =
	| { readonly status: 'published'; readonly result: PublishResult }
	| {
			readonly status: 'status-only'
			readonly reason: string
			/** `false` when an existing summary comment was kept as it was. */
			readonly posted: boolean
	  }
	| { readonly status: 'not-published'; readonly reason: string }
	| { readonly status: 'failed'; readonly reason: string }

/**
 * Publishes an outcome on its pull request: a reviewed run gets threads and the sticky summary, an
 * offline endpoint only the summary. A skip, an invalid configuration or a git failure posts
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

		const publish = Effect.fn('PublishRunService.publish')(function* (
			outcome: ShadowOutcome,
			context: PublishContext
		) {
			if (outcome.status === 'reviewed') {
				const { report, event, rules } = outcome
				if (
					report.planReport.plan.skippedRun ||
					report.planReport.plan.runs.length === 0
				)
					return {
						status: 'not-published',
						reason: report.planReport.plan.skippedRun ?? 'nothing to review',
					} satisfies PublishReport
				const result = yield* publisher.publish({
					pullNumber: event.number,
					report,
					rules,
					head: event.headSha,
					engineCommit: context.engineCommit,
				})
				return { status: 'published', result } satisfies PublishReport
			}
			if (outcome.status === 'offline') {
				const reason = `Reviewer offline: ${outcome.reason}. Nothing was reviewed.`
				const posted = yield* publisher.publishStatus({
					pullNumber: outcome.event.number,
					status: reason,
					head: outcome.event.headSha,
					engineCommit: context.engineCommit,
				})
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
