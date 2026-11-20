import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import type {
	BotThread,
	RecheckProposal,
	ResolvedThread,
} from '../domain/publish.types'
import { getApplicableProposals } from '../domain/thread-recheck.helper'
import {
	type BlobLinks,
	formatResolvedReply,
} from '../presentation/thread-comment.formatter'

/** The re-check's proposals and the publisher's own read of the bot's threads, made just before. */
export interface ThreadResolutionInput {
	readonly links: BlobLinks
	readonly proposals: readonly RecheckProposal[]
	readonly threads: readonly BotThread[]
}

/**
 * Resolves the threads the re-check proposed, when the publisher's fresh read still shows each
 * one as the bot's, with the proposal's fingerprint, open, unanswered, and posted before the head
 * (`getApplicableProposals`). Each gets a one-line reply with the head and the reason, which closes
 * it for the bot's counts, then a try to resolve it on GitHub, which needs `contents: write` the
 * job usually lacks. A failed reply leaves the thread untouched and out of the result.
 */
export class ThreadResolutionService extends Context.Service<
	ThreadResolutionService,
	{
		readonly apply: (
			input: ThreadResolutionInput
		) => Effect.Effect<readonly ResolvedThread[]>
	}
>()('mng-review/ThreadResolutionService') {}

export const ThreadResolutionServiceLive = Layer.effect(
	ThreadResolutionService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService

		const resolve = Effect.fn('ThreadResolutionService.resolve')(function* (
			resolved: ResolvedThread,
			links: BlobLinks
		) {
			return yield* api
				.replyToThread(
					resolved.thread.id,
					formatResolvedReply(resolved.reason, links)
				)
				.pipe(
					Effect.tap(() =>
						api.resolveThread(resolved.thread.id).pipe(Effect.ignore)
					),
					Effect.as([resolved]),
					Effect.orElseSucceed(() => [])
				)
		})

		const apply = Effect.fn('ThreadResolutionService.apply')(function* (
			input: ThreadResolutionInput
		) {
			const applicable = getApplicableProposals(
				input.proposals,
				input.threads,
				input.links.head
			)
			const resolved = yield* Effect.forEach(
				applicable,
				entry => resolve(entry, input.links),
				{ concurrency: 1 }
			)
			return resolved.flat()
		})

		return { apply }
	})
)
