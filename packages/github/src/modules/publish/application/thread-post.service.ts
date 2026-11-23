import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import { isRefused } from '../domain/bot-thread.helper'
import type { PlannedThread } from '../domain/publish.types'
import {
	formatThreadComment,
	toBlobLinks,
} from '../presentation/thread-comment.formatter'
import type { PublishTarget } from './publish.service.types'

/**
 * Posts the planned comments on whole files as the token's bot, one at a time, since a review's
 * comments cannot be on a file. Line threads go into the run's review (`SummaryReviewService`).
 */
export class ThreadPostService extends Context.Service<
	ThreadPostService,
	{
		/**
		 * Each thread planned for its file, with the place it got: on its file, in the summary after
		 * GitHub refused it (422), or unposted when GitHub's answer leaves it unknown. Other threads
		 * come back as they were.
		 */
		readonly postFiles: (
			input: PublishTarget,
			threads: readonly PlannedThread[]
		) => Effect.Effect<readonly PlannedThread[]>
	}
>()('mng-review/ThreadPostService') {}

export const ThreadPostServiceLive = Layer.effect(
	ThreadPostService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const config = yield* GitHubConfig

		const postFile = Effect.fn('ThreadPostService.postFile')(function* (
			input: PublishTarget,
			thread: PlannedThread
		) {
			const links = toBlobLinks(config, input)
			const toPlace = (place: PlannedThread['place']): PlannedThread => ({
				...thread,
				place,
			})
			return yield* api
				.createReviewComment(input.pullNumber, {
					commitId: input.head,
					path: thread.finding.path,
					body: formatThreadComment(thread, links, false),
				})
				.pipe(
					Effect.as(toPlace('file')),
					Effect.catch(error =>
						Effect.succeed(toPlace(isRefused(error) ? 'summary' : 'unposted'))
					)
				)
		})

		const postFiles = Effect.fn('ThreadPostService.postFiles')(function* (
			input: PublishTarget,
			threads: readonly PlannedThread[]
		) {
			return yield* Effect.forEach(
				threads,
				thread =>
					thread.place === 'file'
						? postFile(input, thread)
						: Effect.succeed(thread),
				{ concurrency: 1 }
			)
		})

		return { postFiles }
	})
)
