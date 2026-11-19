import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubStatusService } from '../../../platform/github-status.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { toBotThread } from '../../publish/domain/bot-thread.helper'
import { toSweptStatus } from '../domain/status.helper'

/** What a sweep did. */
export interface SweepResult {
	/** Open pull requests whose head carried the bot's `MNG Review` status. */
	readonly checked: number
	readonly updated: number
	/** Pull requests the sweep could not read or update. */
	readonly failed: number
}

/**
 * Refreshes the `MNG Review` status of open pull requests whose head already carries it, from the
 * bot's open bug threads now, so a thread resolved by hand counts. It runs no model and posts no
 * comment; pull requests the bot never reviewed are left alone. It reads the status again right
 * before it writes and leaves a newer one alone; a publish run that lands between that read and
 * the write can still be overwritten until the next sweep or push.
 */
export class StatusSweepService extends Context.Service<
	StatusSweepService,
	{ readonly sweep: () => Effect.Effect<SweepResult, GitHubApiError> }
>()('mng-review/StatusSweepService') {}

export const StatusSweepServiceLive = Layer.effect(
	StatusSweepService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const github = yield* GitHubStatusService

		/** One pull request: `unknown` when it has no status of the bot, else whether it changed. */
		const sweepOne = Effect.fn('StatusSweepService.sweepOne')(function* (
			pullNumber: number,
			head: string
		) {
			const previous = yield* github.getStatus(head)
			if (!previous) return 'unknown' as const
			const threads = (yield* api.listReviewThreads(pullNumber)).flatMap(
				thread => toBotThread(thread) ?? []
			)
			const openBugs = threads.filter(
				thread => !thread.resolved && thread.marker.kind === 'bug'
			).length
			const next = toSweptStatus(previous, openBugs)
			if (!next) return 'kept' as const
			// A publish run may have set a newer status while the threads were read.
			const latest = yield* github.getStatus(head)
			if (latest?.id !== previous.id) return 'kept' as const
			yield* github.setStatus({ sha: head, ...next })
			return 'updated' as const
		})

		const sweep = Effect.fn('StatusSweepService.sweep')(function* () {
			const pulls = yield* github.listOpenPullRequests()
			const outcomes = yield* Effect.forEach(
				pulls,
				pull =>
					sweepOne(pull.number, pull.head.sha).pipe(
						Effect.orElseSucceed(() => 'failed' as const)
					),
				{ concurrency: 1 }
			)
			return {
				checked: outcomes.filter(outcome => outcome !== 'unknown').length,
				updated: outcomes.filter(outcome => outcome === 'updated').length,
				failed: outcomes.filter(outcome => outcome === 'failed').length,
			}
		})

		return { sweep }
	})
)
