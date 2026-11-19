import { REDACTED } from '@mng-review/engine'
import {
	Context,
	Duration,
	Effect,
	Layer,
	Predicate,
	Redacted,
	Schema,
} from 'effect'
import {
	HttpClient,
	HttpClientRequest,
	type HttpClientResponse,
} from 'effect/http'
import {
	API_VERSION,
	PULL_REQUEST_COMMENTS_QUERY,
	REPLY_TO_THREAD_MUTATION,
	REQUEST_TIMEOUT,
	RESOLVE_THREAD_MUTATION,
	REVIEW_THREADS_QUERY,
} from './github-api.constants'
import { collect, getGraphqlErrors, read } from './github-api.helper'
import {
	createdSchema,
	errorBodySchema,
	mutationAnswerSchema,
	type PullRequestComment,
	pullRequestCommentsAnswerSchema,
	type ReviewThread,
	reviewThreadsAnswerSchema,
} from './github-api.schema'
import { GitHubConfig } from './github.config'
import { GitHubApiError } from './github.errors'

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
		/** Replies in a review thread by its GraphQL node id. */
		readonly replyToThread: (
			threadId: string,
			body: string
		) => Effect.Effect<void, GitHubApiError>
		readonly resolveThread: (
			threadId: string
		) => Effect.Effect<void, GitHubApiError>
	}
>()('mng-review/GitHubApiService') {}

export const GitHubApiServiceLive = Layer.effect(
	GitHubApiService,
	Effect.gen(function* () {
		const config = yield* GitHubConfig
		const client = yield* HttpClient.HttpClient
		const repo = `${config.apiUrl}/repos/${config.owner}/${config.name}`

		/** GitHub's message with the token replaced, in case an upstream error echoes it. */
		const toSafeReason = (message: string): string => {
			const token = Redacted.value(config.token)
			return token ? message.replaceAll(token, REDACTED) : message
		}

		/** Sends a request with the token and the API version; a non-2xx answer fails with GitHub's message. */
		const send = (
			operation: string,
			request: HttpClientRequest.HttpClientRequest
		): Effect.Effect<HttpClientResponse.HttpClientResponse, GitHubApiError> =>
			client
				.execute(
					request.pipe(
						HttpClientRequest.bearerToken(Redacted.value(config.token)),
						HttpClientRequest.setHeaders({
							accept: 'application/vnd.github+json',
							'x-github-api-version': API_VERSION,
							'user-agent': 'mng-review',
						})
					)
				)
				.pipe(
					Effect.mapError(
						error =>
							new GitHubApiError({ operation, reason: error.reason._tag })
					),
					Effect.flatMap(response =>
						response.status >= 200 && response.status < 300
							? Effect.succeed(response)
							: response.json.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(errorBodySchema)),
									Effect.map(body => toSafeReason(body.message)),
									Effect.orElseSucceed(() => 'no message'),
									Effect.flatMap(reason =>
										Effect.fail(
											new GitHubApiError({
												operation,
												status: response.status,
												reason,
											})
										)
									)
								)
					),
					// Spans would record request URLs and headers.
					Effect.withTracerEnabled(false)
				)

		/** Sends a request and decodes its JSON body; the whole exchange has `REQUEST_TIMEOUT`. */
		const sendJson = <TValue>(
			operation: string,
			request: HttpClientRequest.HttpClientRequest,
			schema: Schema.Decoder<TValue>
		): Effect.Effect<TValue, GitHubApiError> =>
			send(operation, request).pipe(
				Effect.flatMap(response => response.json),
				Effect.flatMap(Schema.decodeUnknownEffect(schema)),
				Effect.timeout(REQUEST_TIMEOUT),
				Effect.mapError(error => {
					if (Predicate.isTagged(error, 'GitHubApiError')) return error
					if (Predicate.isTagged(error, 'TimeoutError'))
						return new GitHubApiError({
							operation,
							reason: `no answer within ${Duration.format(REQUEST_TIMEOUT)}`,
						})
					return new GitHubApiError({ operation, reason: 'unexpected answer' })
				})
			)

		/** A GraphQL request, sent once; errors beside data fail it. */
		const graphql = <
			TAnswer extends {
				readonly errors?: readonly { readonly message: string }[] | undefined
			},
		>(
			operation: string,
			text: string,
			variables: Record<string, unknown>,
			schema: Schema.Decoder<TAnswer>
		): Effect.Effect<TAnswer, GitHubApiError> =>
			sendJson(
				operation,
				HttpClientRequest.post(config.graphqlUrl).pipe(
					HttpClientRequest.bodyJsonUnsafe({ query: text, variables })
				),
				schema
			).pipe(
				Effect.flatMap(answer => {
					const errors = getGraphqlErrors(answer.errors)
					return errors === undefined
						? Effect.succeed(answer)
						: Effect.fail(
								new GitHubApiError({ operation, reason: toSafeReason(errors) })
							)
				})
			)

		/** A GraphQL query, retried like every read. */
		const query = <
			TAnswer extends {
				readonly errors?: readonly { readonly message: string }[] | undefined
			},
		>(
			operation: string,
			text: string,
			variables: Record<string, unknown>,
			schema: Schema.Decoder<TAnswer>
		): Effect.Effect<TAnswer, GitHubApiError> =>
			read(graphql(operation, text, variables, schema))

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

		return {
			replyToThread,
			resolveThread,
			listReviewThreads,
			listComments,
			createReview,
			createReviewComment,
			createIssueComment,
			updateIssueComment,
		}
	})
)
