import { Context, Effect, Layer, Result } from 'effect'
import { isIdentity } from '../../../platform/bot-identity.helper'
import { isTransient } from '../../../platform/github-api.helper'
import type { PullRequestReview } from '../../../platform/github-api.schema'
import {
	GitHubReviewService,
	REVIEW_STATE_BY_EVENT,
	type ReviewInput,
} from '../../../platform/github-review.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { restartListCount } from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { isRefused } from '../domain/bot-thread.helper'
import type { DecidedSummary } from '../domain/publish.types'
import type { PostedReview, SummaryDraft } from './summary-review.service.types'

/** Submits the bot's reviews for the summary write and the manual run reservation. */
export class ReviewPostService extends Context.Service<
	ReviewPostService,
	{
		/**
		 * Submits a review. A create with no answer or a 5xx is checked by a read: a review of the
		 * current identity that was not in `before` and has this body is taken as this one. That read
		 * keeps a count of its own: it comes after the decision and only looks for this review, so a
		 * node it leaves out marks no run incomplete, and when that node is this review the create
		 * fails unconfirmed.
		 */
		readonly create: (
			pullNumber: number,
			input: ReviewInput,
			before: readonly PullRequestReview[]
		) => Effect.Effect<number, GitHubApiError, OwnedIdentities>
		/**
		 * Posts the run's review with its inline comments and the decided state. When GitHub refuses
		 * one comment (422), the summary is rendered again with their findings in the body, decided
		 * again, and posted with no comments.
		 */
		readonly post: (
			pullNumber: number,
			draft: SummaryDraft,
			decided: DecidedSummary,
			retry: () => DecidedSummary,
			before: readonly PullRequestReview[]
		) => Effect.Effect<PostedReview, GitHubApiError, OwnedIdentities>
	}
>()('mng-review/ReviewPostService') {}

export const ReviewPostServiceLive = Layer.effect(
	ReviewPostService,
	Effect.gen(function* () {
		const github = yield* GitHubReviewService

		const create = Effect.fn('ReviewPostService.create')(function* (
			pullNumber: number,
			input: ReviewInput,
			before: readonly PullRequestReview[]
		) {
			const created = yield* Effect.result(
				github.createReview(pullNumber, input)
			)
			if (Result.isSuccess(created)) return created.success
			if (!isTransient(created.failure)) return yield* created.failure
			const { current } = yield* OwnedIdentities
			const known = new Set(before.map(review => review.databaseId))
			const own = (yield* restartListCount(
				github.listReviews(pullNumber)
			)).findLast(
				review =>
					!known.has(review.databaseId) &&
					isIdentity(review.author, current) &&
					review.body === input.body
			)
			if (own?.databaseId === null || own?.databaseId === undefined)
				return yield* created.failure
			return own.databaseId
		})

		const post = Effect.fn('ReviewPostService.post')(function* (
			pullNumber: number,
			draft: SummaryDraft,
			decided: DecidedSummary,
			retry: () => DecidedSummary,
			before: readonly PullRequestReview[]
		) {
			const comments = draft.comments ?? []
			const review = {
				commitId: draft.head,
				event: decided.decision.event,
				body: decided.rendered.body,
				comments,
			} satisfies ReviewInput
			const first = yield* Effect.result(create(pullNumber, review, before))
			const posted = (id: number, chosen: DecidedSummary, inline: boolean) =>
				({
					id,
					...chosen,
					review: {
						state: REVIEW_STATE_BY_EVENT[chosen.decision.event],
						commit: draft.head,
					},
					inline,
				}) satisfies PostedReview
			if (Result.isSuccess(first)) return posted(first.success, decided, true)
			if (comments.length === 0 || !isRefused(first.failure))
				return yield* first.failure
			const fallback = retry()
			const id = yield* create(
				pullNumber,
				{
					...review,
					event: fallback.decision.event,
					body: fallback.rendered.body,
					comments: [],
				},
				before
			)
			return posted(id, fallback, false)
		})

		return { create, post }
	})
)
