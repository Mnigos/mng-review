import { Context, Effect, Layer } from 'effect'
import { isDeclined, isNotFound } from '../../../platform/github-api.helper'
import { GitHubApiService } from '../../../platform/github-api.service'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import type { SummaryCleanup, SummaryComment } from '../domain/publish.types'
import { toSummaryCleanup } from '../domain/summary-comment.helper'
import {
	getStaleReviews,
	type WriteHeads,
} from '../domain/summary-review.helper'
import type { SummaryRead } from './summary-review.service.types'

/** Leaves a review or comment visible on a failure, retried on the next write. */
const keepOnFailure = Effect.orElseSucceed((): SummaryCleanup => 'kept')

/**
 * Hides what a summary write left outdated: every earlier review of an owned identity and every
 * old sticky comment. A submitted review cannot be deleted, so one GitHub refuses to hide stays
 * `kept`; the next write tries again.
 */
export class SummaryCleanupService extends Context.Service<
	SummaryCleanupService,
	{
		/**
		 * Hides the reviews and comments of `found` but `kept`, the review the write left. An approval
		 * or change request on the current head stays visible when the run reviewed another head, and
		 * every one when the current head could not be read.
		 */
		readonly cleanUp: (
			found: SummaryRead,
			kept: number,
			heads: WriteHeads
		) => Effect.Effect<SummaryCleanup, never, OwnedIdentities>
	}
>()('mng-review/SummaryCleanupService') {}

export const SummaryCleanupServiceLive = Layer.effect(
	SummaryCleanupService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService

		/** Hides an old sticky comment, deleting it only when GitHub refuses to hide it. */
		const hideComment = (summary: SummaryComment) =>
			api.minimizeComment(summary.nodeId).pipe(
				Effect.as<SummaryCleanup>('minimized'),
				Effect.catchIf(isDeclined, () =>
					api.deleteIssueComment(summary.id).pipe(
						Effect.catchIf(isNotFound, () => Effect.void),
						Effect.as<SummaryCleanup>('deleted'),
						keepOnFailure
					)
				),
				keepOnFailure
			)

		const cleanUp = Effect.fn('SummaryCleanupService.cleanUp')(function* (
			found: SummaryRead,
			kept: number,
			heads: WriteHeads
		) {
			const { identities } = yield* OwnedIdentities
			const reviews = yield* Effect.forEach(
				getStaleReviews(found.raw, identities, kept, heads),
				review =>
					api
						.minimizeComment(review.id)
						.pipe(Effect.as<SummaryCleanup>('minimized'), keepOnFailure),
				{ concurrency: 1 }
			)
			const comments = yield* Effect.forEach(found.summaries, hideComment, {
				concurrency: 1,
			})
			return toSummaryCleanup([...reviews, ...comments])
		})

		return { cleanUp }
	})
)
