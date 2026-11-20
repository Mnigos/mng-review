import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import { toCodeSpan } from '../../../utils/markdown.util'
import { isRefused } from '../domain/bot-thread.helper'
import { SHORT_SHA_LENGTH } from '../domain/publish.constants'
import type { PlannedThread } from '../domain/publish.types'
import {
	formatThreadComment,
	toBlobLinks,
} from '../presentation/thread-comment.formatter'
import type { PublishTarget } from './publish.service.types'

/**
 * Posts planned threads on a pull request as the token's bot and returns each with the place it
 * got: on its line, on its file, in the summary, or unposted when GitHub's answer leaves it unknown.
 */
export class ThreadPostService extends Context.Service<
	ThreadPostService,
	{
		readonly postThreads: (
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

		/** One thread through its fallbacks, line, file, summary; only a 422 moves it on. */
		const postSingle = Effect.fn('ThreadPostService.postSingle')(function* (
			input: PublishTarget,
			thread: PlannedThread
		) {
			const links = toBlobLinks(config, input)
			const post = (onLine: boolean) =>
				api.createReviewComment(input.pullNumber, {
					commitId: input.head,
					path: thread.finding.path,
					...(onLine ? { line: thread.finding.line } : {}),
					body: formatThreadComment(thread, links, onLine),
				})
			const toPlace = (place: PlannedThread['place']): PlannedThread => ({
				...thread,
				place,
			})
			const onFile = post(false).pipe(
				Effect.as(toPlace('file')),
				Effect.catch(error =>
					Effect.succeed(toPlace(isRefused(error) ? 'summary' : 'unposted'))
				)
			)
			if (thread.place !== 'line') return yield* onFile
			return yield* post(true).pipe(
				Effect.as(toPlace('line')),
				Effect.catch(error =>
					isRefused(error) ? onFile : Effect.succeed(toPlace('unposted'))
				)
			)
		})

		/**
		 * Posts the inline threads in one `COMMENT` review. When GitHub refuses it (a line it does
		 * not accept), each thread goes through its fallbacks alone, one at a time, since GitHub
		 * limits how fast content is created; after any other failure the review may exist, so the
		 * threads stay unposted. File comments follow.
		 */
		const postThreads = Effect.fn('ThreadPostService.postThreads')(function* (
			input: PublishTarget,
			threads: readonly PlannedThread[]
		) {
			const links = toBlobLinks(config, input)
			const onLine = threads.filter(thread => thread.place === 'line')
			const rest = threads.filter(thread => thread.place !== 'line')
			const review =
				onLine.length === 0
					? 'posted'
					: yield* api
							.createReview(input.pullNumber, {
								commitId: input.head,
								body: `MNG Review: ${onLine.length} new comment(s) on ${toCodeSpan(input.head.slice(0, SHORT_SHA_LENGTH))}. The summary is in the conversation.`,
								comments: onLine.map(thread => ({
									path: thread.finding.path,
									line: thread.finding.line,
									body: formatThreadComment(thread, links, true),
								})),
							})
							.pipe(
								Effect.as('posted' as const),
								Effect.catch(error =>
									Effect.succeed(isRefused(error) ? 'refused' : 'unknown')
								)
							)
			const lineResults =
				review === 'refused'
					? yield* Effect.forEach(onLine, thread => postSingle(input, thread), {
							concurrency: 1,
						})
					: onLine.map(thread =>
							review === 'posted'
								? thread
								: { ...thread, place: 'unposted' as const }
						)
			const restResults = yield* Effect.forEach(
				rest,
				thread =>
					thread.place === 'file'
						? postSingle(input, thread)
						: Effect.succeed(thread),
				{ concurrency: 1 }
			)
			return [...lineResults, ...restResults]
		})

		return { postThreads }
	})
)
