import { Context, Effect, Layer } from 'effect'
import { HttpClientRequest } from 'effect/http'
import { PULL_REQUEST_REVIEWS_QUERY } from './github-api.constants'
import { collect } from './github-api.helper'
import {
	createdSchema,
	type PullRequestReview,
	pullRequestReviewsAnswerSchema,
	type ReviewState,
} from './github-api.schema'
import { makeGitHubHttp } from './github-http.client'
import type { GitHubApiError } from './github.errors'

/** The events a submitted review can carry, as the REST API names them. */
export const REVIEW_EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const
export type ReviewEvent = (typeof REVIEW_EVENTS)[number]
/** The state a review submitted with each event gets. */
export const REVIEW_STATE_BY_EVENT = {
	COMMENT: 'COMMENTED',
	APPROVE: 'APPROVED',
	REQUEST_CHANGES: 'CHANGES_REQUESTED',
} as const satisfies Record<ReviewEvent, ReviewState>

/** One inline comment of a review, on a line of the head side of the diff. */
export interface InlineComment {
	readonly path: string
	readonly line: number
	readonly body: string
}

/** A review the bot submits: its event, its body and the run's new inline comments. */
export interface ReviewInput {
	readonly commitId: string
	readonly event: ReviewEvent
	readonly body: string
	readonly comments: readonly InlineComment[]
}

/** The review calls publishing makes on one pull request of the configured repository. */
export class GitHubReviewService extends Context.Service<
	GitHubReviewService,
	{
		/** Every review of the pull request, hidden and dismissed ones included, oldest first. */
		readonly listReviews: (
			pullNumber: number
		) => Effect.Effect<readonly PullRequestReview[], GitHubApiError>
		/** Submits a review; one comment GitHub cannot place refuses the whole review with 422. */
		readonly createReview: (
			pullNumber: number,
			input: ReviewInput
		) => Effect.Effect<number, GitHubApiError>
		/** Replaces the body of a submitted review; its state stays. */
		readonly updateReview: (
			pullNumber: number,
			reviewId: number,
			body: string
		) => Effect.Effect<void, GitHubApiError>
	}
>()('mng-review/GitHubReviewService') {}

export const GitHubReviewServiceLive = Layer.effect(
	GitHubReviewService,
	Effect.gen(function* () {
		const { config, repo, sendJson, query } = yield* makeGitHubHttp

		const listReviews = Effect.fn('GitHubReviewService.listReviews')(function* (
			pullNumber: number
		) {
			return yield* collect(
				'listReviews',
				cursor =>
					query(
						'listReviews',
						PULL_REQUEST_REVIEWS_QUERY,
						{
							owner: config.owner,
							name: config.name,
							number: pullNumber,
							cursor,
						},
						pullRequestReviewsAnswerSchema
					).pipe(
						Effect.map(answer => answer.data?.repository?.pullRequest?.reviews)
					),
				null,
				0
			)
		})

		const createReview = Effect.fn('GitHubReviewService.createReview')(
			function* (pullNumber: number, input: ReviewInput) {
				const created = yield* sendJson(
					'createReview',
					HttpClientRequest.post(`${repo}/pulls/${pullNumber}/reviews`).pipe(
						HttpClientRequest.bodyJsonUnsafe({
							commit_id: input.commitId,
							event: input.event,
							body: input.body,
							comments: input.comments.map(comment => ({
								path: comment.path,
								line: comment.line,
								side: 'RIGHT',
								body: comment.body,
							})),
						})
					),
					createdSchema
				)
				return created.id
			}
		)

		const updateReview = Effect.fn('GitHubReviewService.updateReview')(
			function* (pullNumber: number, reviewId: number, body: string) {
				yield* sendJson(
					'updateReview',
					HttpClientRequest.put(
						`${repo}/pulls/${pullNumber}/reviews/${reviewId}`
					).pipe(HttpClientRequest.bodyJsonUnsafe({ body })),
					createdSchema
				)
			}
		)

		return { listReviews, createReview, updateReview }
	})
)
