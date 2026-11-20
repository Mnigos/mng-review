import { Context, Effect, Layer } from 'effect'
import { HttpClientRequest } from 'effect/http'
import {
	MINIMIZE_COMMENT_MUTATION,
	PULL_REQUEST_COMMENTS_QUERY,
	REPLY_TO_THREAD_MUTATION,
	RESOLVE_THREAD_MUTATION,
	REVIEW_THREADS_QUERY,
} from './github-api.constants'
import { collect, read } from './github-api.helper'
import {
	collaboratorRoleSchema,
	createdSchema,
	type IssueComment,
	issueCommentSchema,
	mutationAnswerSchema,
	type PullRequest,
	type PullRequestComment,
	pullRequestCommentsAnswerSchema,
	type ReviewThread,
	pullRequestSchema,
	reviewThreadsAnswerSchema,
} from './github-api.schema'
import { makeGitHubHttp } from './github-http.client'
import type { GitHubApiError } from './github.errors'

/** One inline comment of a review, on a line of the head side of the diff. */
export interface InlineComment {
	readonly path: string
	readonly line: number
	readonly body: string
}

/** A review the bot posts: always `COMMENT`, never an approval or a change request. */
export interface ReviewInput {
	readonly commitId: string
	readonly body: string
	readonly comments: readonly InlineComment[]
}

/** A single review comment: on a line, or on the whole file when `line` is unset. */
export interface ReviewCommentInput {
	readonly commitId: string
	readonly path: string
	readonly line?: number
	readonly body: string
}

/** The calls publishing makes on one pull request of the configured repository. */
export class GitHubApiService extends Context.Service<
	GitHubApiService,
	{
		readonly listReviewThreads: (
			pullNumber: number
		) => Effect.Effect<readonly ReviewThread[], GitHubApiError>
		readonly listComments: (
			pullNumber: number
		) => Effect.Effect<readonly PullRequestComment[], GitHubApiError>
		readonly createReview: (
			pullNumber: number,
			input: ReviewInput
		) => Effect.Effect<number, GitHubApiError>
		readonly createReviewComment: (
			pullNumber: number,
			input: ReviewCommentInput
		) => Effect.Effect<number, GitHubApiError>
		readonly createIssueComment: (
			pullNumber: number,
			body: string
		) => Effect.Effect<number, GitHubApiError>
		readonly updateIssueComment: (
			commentId: number,
			body: string
		) => Effect.Effect<void, GitHubApiError>
		readonly deleteIssueComment: (
			commentId: number
		) => Effect.Effect<void, GitHubApiError>
		/** Hides a conversation comment as outdated, by its GraphQL node id. */
		readonly minimizeComment: (
			nodeId: string
		) => Effect.Effect<void, GitHubApiError>
		/** Replies in a review thread by its GraphQL node id. */
		readonly replyToThread: (
			threadId: string,
			body: string
		) => Effect.Effect<void, GitHubApiError>
		readonly resolveThread: (
			threadId: string
		) => Effect.Effect<void, GitHubApiError>
		readonly getPullRequest: (
			pullNumber: number
		) => Effect.Effect<PullRequest, GitHubApiError>
		/** A conversation comment as it is now; a deleted one fails with 404. */
		readonly getIssueComment: (
			commentId: number
		) => Effect.Effect<IssueComment, GitHubApiError>
		/** The login's role on the repository; a login that is no collaborator fails with 404. */
		readonly getCollaboratorRole: (
			login: string
		) => Effect.Effect<string, GitHubApiError>
	}
>()('mng-review/GitHubApiService') {}

export const GitHubApiServiceLive = Layer.effect(
	GitHubApiService,
	Effect.gen(function* () {
		const { config, repo, sendJson, sendEmpty, graphql, query } =
			yield* makeGitHubHttp

		/** The variables every pull request query takes. */
		const toVariables = (pullNumber: number, cursor: string | null) => ({
			owner: config.owner,
			name: config.name,
			number: pullNumber,
			cursor,
		})

		const listReviewThreads = Effect.fn('GitHubApiService.listReviewThreads')(
			function* (pullNumber: number) {
				return yield* collect(
					'listReviewThreads',
					cursor =>
						query(
							'listReviewThreads',
							REVIEW_THREADS_QUERY,
							toVariables(pullNumber, cursor),
							reviewThreadsAnswerSchema
						).pipe(
							Effect.map(
								answer => answer.data?.repository?.pullRequest?.reviewThreads
							)
						),
					null,
					0
				)
			}
		)

		const listComments = Effect.fn('GitHubApiService.listComments')(function* (
			pullNumber: number
		) {
			return yield* collect(
				'listComments',
				cursor =>
					query(
						'listComments',
						PULL_REQUEST_COMMENTS_QUERY,
						toVariables(pullNumber, cursor),
						pullRequestCommentsAnswerSchema
					).pipe(
						Effect.map(answer => answer.data?.repository?.pullRequest?.comments)
					),
				null,
				0
			)
		})

		const createReview = Effect.fn('GitHubApiService.createReview')(function* (
			pullNumber: number,
			input: ReviewInput
		) {
			const created = yield* sendJson(
				'createReview',
				HttpClientRequest.post(`${repo}/pulls/${pullNumber}/reviews`).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						commit_id: input.commitId,
						event: 'COMMENT',
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
		})

		const createReviewComment = Effect.fn(
			'GitHubApiService.createReviewComment'
		)(function* (pullNumber: number, input: ReviewCommentInput) {
			const place =
				input.line === undefined
					? { subject_type: 'file' }
					: { line: input.line, side: 'RIGHT' }
			const created = yield* sendJson(
				'createReviewComment',
				HttpClientRequest.post(`${repo}/pulls/${pullNumber}/comments`).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						commit_id: input.commitId,
						path: input.path,
						body: input.body,
						...place,
					})
				),
				createdSchema
			)
			return created.id
		})

		const createIssueComment = Effect.fn('GitHubApiService.createIssueComment')(
			function* (pullNumber: number, body: string) {
				const created = yield* sendJson(
					'createIssueComment',
					HttpClientRequest.post(`${repo}/issues/${pullNumber}/comments`).pipe(
						HttpClientRequest.bodyJsonUnsafe({ body })
					),
					createdSchema
				)
				return created.id
			}
		)

		const updateIssueComment = Effect.fn('GitHubApiService.updateIssueComment')(
			function* (commentId: number, body: string) {
				yield* sendJson(
					'updateIssueComment',
					HttpClientRequest.patch(`${repo}/issues/comments/${commentId}`).pipe(
						HttpClientRequest.bodyJsonUnsafe({ body })
					),
					createdSchema
				)
			}
		)

		const deleteIssueComment = Effect.fn('GitHubApiService.deleteIssueComment')(
			function* (commentId: number) {
				yield* sendEmpty(
					'deleteIssueComment',
					HttpClientRequest.delete(`${repo}/issues/comments/${commentId}`)
				)
			}
		)

		const minimizeComment = Effect.fn('GitHubApiService.minimizeComment')(
			function* (nodeId: string) {
				yield* graphql(
					'minimizeComment',
					MINIMIZE_COMMENT_MUTATION,
					{ id: nodeId },
					mutationAnswerSchema
				)
			}
		)

		const replyToThread = Effect.fn('GitHubApiService.replyToThread')(
			function* (threadId: string, body: string) {
				yield* graphql(
					'replyToThread',
					REPLY_TO_THREAD_MUTATION,
					{ thread: threadId, body },
					mutationAnswerSchema
				)
			}
		)

		const resolveThread = Effect.fn('GitHubApiService.resolveThread')(
			function* (threadId: string) {
				yield* graphql(
					'resolveThread',
					RESOLVE_THREAD_MUTATION,
					{ thread: threadId },
					mutationAnswerSchema
				)
			}
		)

		const getPullRequest = Effect.fn('GitHubApiService.getPullRequest')(
			function* (pullNumber: number) {
				return yield* read(
					sendJson(
						'getPullRequest',
						HttpClientRequest.get(`${repo}/pulls/${pullNumber}`),
						pullRequestSchema
					)
				)
			}
		)

		const getIssueComment = Effect.fn('GitHubApiService.getIssueComment')(
			function* (commentId: number) {
				return yield* read(
					sendJson(
						'getIssueComment',
						HttpClientRequest.get(`${repo}/issues/comments/${commentId}`),
						issueCommentSchema
					)
				)
			}
		)

		const getCollaboratorRole = Effect.fn(
			'GitHubApiService.getCollaboratorRole'
		)(function* (login: string) {
			const answer = yield* read(
				sendJson(
					'getCollaboratorRole',
					HttpClientRequest.get(
						`${repo}/collaborators/${encodeURIComponent(login)}/permission`
					),
					collaboratorRoleSchema
				)
			)
			return answer.role_name
		})

		return {
			getPullRequest,
			getIssueComment,
			getCollaboratorRole,
			replyToThread,
			resolveThread,
			listReviewThreads,
			listComments,
			createReview,
			createReviewComment,
			createIssueComment,
			updateIssueComment,
			deleteIssueComment,
			minimizeComment,
		}
	})
)
