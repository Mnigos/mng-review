import { Effect, Layer, Redacted, Schema } from 'effect'
import {
	HttpClient,
	HttpClientError,
	type HttpClientRequest,
	HttpClientResponse,
} from 'effect/http'
import { GITHUB_ACTIONS_IDENTITY } from '../../platform/bot-identity.helper'
import type {
	ConnectionPage,
	PullRequestComment,
	PullRequestReview,
	ReviewThread,
	ThreadComment,
} from '../../platform/github-api.schema'
import {
	GitHubApiService,
	GitHubApiServiceLive,
} from '../../platform/github-api.service'
import {
	GitHubReviewService,
	GitHubReviewServiceLive,
} from '../../platform/github-review.service'
import { GitHubRiskServiceLive } from '../../platform/github-risk.service'
import { GitHubStatusServiceLive } from '../../platform/github-status.service'
import { GitHubConfig } from '../../platform/github.config'

export const GITHUB_CREDENTIAL = 'fixture-github-credential'
export const GITHUB_SETTINGS = {
	owner: 'example-owner',
	name: 'example-repo',
	serverUrl: 'https://github.example.test',
	apiUrl: 'https://github.example.test/api/v3',
	graphqlUrl: 'https://github.example.test/api/graphql',
	token: Redacted.make(GITHUB_CREDENTIAL),
	identity: GITHUB_ACTIONS_IDENTITY,
} as const satisfies GitHubConfig['Service']
export const ISSUE_COMMENT = {
	id: 'comment-node-17',
	databaseId: 17,
	isMinimized: false,
	body: 'Conversation comment',
	author: { __typename: 'Bot', login: 'review-bot' },
	editor: { __typename: 'User', login: 'editor' },
} as const satisfies PullRequestComment
export const REVIEW_THREAD = {
	id: 'thread-1',
	isResolved: false,
	isOutdated: true,
	path: 'src/example.ts',
	line: null,
	originalLine: 12,
	subjectType: 'LINE',
	comments: {
		totalCount: 2,
		nodes: [
			{
				databaseId: ISSUE_COMMENT.databaseId,
				body: ISSUE_COMMENT.body,
				author: ISSUE_COMMENT.author,
				editor: ISSUE_COMMENT.editor,
				originalCommit: { oid: 'abcdef1234567' },
			},
		],
	},
} as const satisfies ReviewThread

export type GitHubReply = (
	request: HttpClientRequest.HttpClientRequest,
	attempt: number
) => Effect.Effect<Response, HttpClientError.HttpClientError>

/** Captures the real client's requests while replacing all HTTP with an in-memory reply. */
export function makeGitHubHttp(
	reply: GitHubReply,
	settings: GitHubConfig['Service'] = GITHUB_SETTINGS
) {
	const requests: HttpClientRequest.HttpClientRequest[] = []
	const client = HttpClient.make(request =>
		Effect.gen(function* () {
			requests.push(request)
			return HttpClientResponse.fromWeb(
				request,
				yield* reply(request, requests.length)
			)
		})
	)
	const dependencies = Layer.merge(
		Layer.succeed(GitHubConfig, settings),
		Layer.succeed(HttpClient.HttpClient, client)
	)
	return {
		requests,
		riskLayer: GitHubRiskServiceLive.pipe(Layer.provide(dependencies)),
		reviewLayer: GitHubReviewServiceLive.pipe(Layer.provide(dependencies)),
		statusLayer: GitHubStatusServiceLive.pipe(Layer.provide(dependencies)),
		layer: GitHubApiServiceLive.pipe(Layer.provide(dependencies)),
	}
}

export type GitHubConnection = 'reviewThreads' | 'comments' | 'reviews'

/** Wraps a connection in GitHub's GraphQL response envelope. */
export function toGitHubPage<TNode>(
	connection: GitHubConnection,
	nodes: ConnectionPage<TNode>['nodes'],
	hasNextPage = false,
	endCursor: string | null = null
) {
	return {
		data: {
			repository: {
				pullRequest: {
					[connection]: { nodes, pageInfo: { hasNextPage, endCursor } },
				},
			},
		},
	}
}

/** Reads the JSON payload at the fake HTTP boundary. */
export function getGitHubRequestBody(
	request: HttpClientRequest.HttpClientRequest | undefined
): unknown {
	if (request?.body._tag !== 'Uint8Array') return undefined
	return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
		new TextDecoder().decode(request.body.body)
	)
}

/** Simulates a connection failure whose diagnostics must never escape into an API error. */
export function failGitHubTransport(
	request: HttpClientRequest.HttpClientRequest
) {
	return Effect.fail(
		new HttpClientError.HttpClientError({
			reason: new HttpClientError.TransportError({
				request,
				cause: `transport diagnostics include ${GITHUB_CREDENTIAL}`,
			}),
		})
	)
}

/**
 * The real whole-thread read over one page GitHub answers with `nodes`, where `null` is a comment
 * it could not resolve.
 */
export function readThreadOverHttp(nodes: readonly (ThreadComment | null)[]) {
	const http = makeGitHubHttp(() =>
		Effect.succeed(
			Response.json({
				data: {
					node: {
						comments: {
							nodes,
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			})
		)
	)
	return (threadId: string) =>
		GitHubApiService.use(service => service.listThreadComments(threadId)).pipe(
			Effect.provide(http.layer)
		)
}

/** One count of null nodes for each list read of the fake. */
interface NullNodeCounts<TCount> {
	threads: TCount
	comments: TCount
	reviews: TCount
}

/**
 * How many null nodes each list read of the fake lists after its entries, as GitHub can: the next
 * entry of `queued` for that list, one per read, then the count.
 */
export interface NullNodes extends NullNodeCounts<number> {
	readonly queued: NullNodeCounts<number[]>
}

/** No null nodes in any list, until a spec sets some. */
export function toNullNodes(): NullNodes {
	return {
		threads: 0,
		comments: 0,
		reviews: 0,
		queued: { threads: [], comments: [], reviews: [] },
	}
}

/** One page of `entries` and `nulls` null nodes after them, answered to every request. */
function answerListed(
	connection: GitHubConnection,
	entries: readonly unknown[],
	nulls: number
) {
	const nodes = [...entries, ...Array.from({ length: nulls }, () => null)]
	return makeGitHubHttp(() =>
		Effect.succeed(Response.json(toGitHubPage(connection, nodes)))
	)
}

/**
 * The fake's list reads: the entries as they are, or, once a spec sets `nullNodes`, read by the
 * real adapter over one page that lists that many null nodes after them.
 */
export function readListedOverHttp(nullNodes: NullNodes) {
	const toNulls = (list: keyof NullNodeCounts<number>) =>
		nullNodes.queued[list].shift() ?? nullNodes[list]
	return {
		threads: (threads: readonly ReviewThread[]) => {
			const nulls = toNulls('threads')
			return nulls === 0
				? Effect.succeed(threads)
				: GitHubApiService.use(service => service.listReviewThreads(0)).pipe(
						Effect.provide(answerListed('reviewThreads', threads, nulls).layer)
					)
		},
		comments: (comments: readonly PullRequestComment[]) => {
			const nulls = toNulls('comments')
			return nulls === 0
				? Effect.succeed(comments)
				: GitHubApiService.use(service => service.listComments(0)).pipe(
						Effect.provide(answerListed('comments', comments, nulls).layer)
					)
		},
		reviews: (reviews: readonly PullRequestReview[]) => {
			const nulls = toNulls('reviews')
			return nulls === 0
				? Effect.succeed(reviews)
				: GitHubReviewService.use(service => service.listReviews(0)).pipe(
						Effect.provide(answerListed('reviews', reviews, nulls).reviewLayer)
					)
		},
	}
}
