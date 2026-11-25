import { Context, Effect, Layer } from 'effect'
import type { ReviewThread } from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { toBotThread } from '../domain/bot-thread.helper'
import type { BotThread } from '../domain/publish.types'
import type { CheckedRun, PublishInput } from './publish.service.types'

/** The pull request's review threads as GitHub returns them, and the bot's among them. */
export interface ThreadRead {
	readonly raw: readonly ReviewThread[]
	readonly threads: readonly BotThread[]
}

/** What a publish reads of the pull request before it judges: the threads and the head. */
export class PublishReadService extends Context.Service<
	PublishReadService,
	{
		/** The review threads, and the bot's found by an owned author and marker (`toBotThread`). */
		readonly readAll: (
			pullNumber: number
		) => Effect.Effect<ThreadRead, GitHubApiError, OwnedIdentities>
		/**
		 * Whether the run stands for a full review of its head. A push can land while a run reviews,
		 * so the pull request is read again: one whose head moved meanwhile, or cannot be read, is
		 * partial, as is a command that named a single agent.
		 */
		readonly checkRun: (
			input: PublishInput
		) => Effect.Effect<CheckedRun, never, OwnedIdentities>
	}
>()('mng-review/PublishReadService') {}

export const PublishReadServiceLive = Layer.effect(
	PublishReadService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService

		const readAll = Effect.fn('PublishReadService.readAll')(function* (
			pullNumber: number
		) {
			const { identities } = yield* OwnedIdentities
			const raw = yield* api.listReviewThreads(pullNumber)
			const threads = raw.flatMap(
				thread => toBotThread(thread, identities) ?? []
			)
			return { raw, threads } satisfies ThreadRead
		})

		const checkRun = Effect.fn('PublishReadService.checkRun')(function* (
			input: PublishInput
		) {
			const { current } = yield* OwnedIdentities
			const pr = yield* api
				.getPullRequest(input.pullNumber)
				.pipe(Effect.orElseSucceed(() => undefined))
			const moved = pr?.head.sha !== input.head
			return {
				head: input.head,
				partial: input.command?.agentOnly === true || moved,
				moved,
				authored: pr?.user?.login.toLowerCase() === current.restLogin,
			} satisfies CheckedRun
		})

		return { readAll, checkRun }
	})
)
