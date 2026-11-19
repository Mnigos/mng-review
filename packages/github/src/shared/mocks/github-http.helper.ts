import { Effect, Layer, Redacted, Schema } from 'effect'
import {
	HttpClient,
	HttpClientError,
	type HttpClientRequest,
	HttpClientResponse,
} from 'effect/http'
import type {
	ConnectionPage,
	PullRequestComment,
	ReviewThread,
} from '../../platform/github-api.schema'
import { GitHubApiServiceLive } from '../../platform/github-api.service'
import { GitHubConfig } from '../../platform/github.config'

export const GITHUB_CREDENTIAL = 'fixture-github-credential'
export const GITHUB_SETTINGS = {
	owner: 'example-owner',
	name: 'example-repo',
	serverUrl: 'https://github.example.test',
	apiUrl: 'https://github.example.test/api/v3',
	graphqlUrl: 'https://github.example.test/api/graphql',
	token: Redacted.make(GITHUB_CREDENTIAL),
} as const satisfies GitHubConfig['Service']
export const ISSUE_COMMENT = {
	databaseId: 17,
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
		nodes: [{ ...ISSUE_COMMENT, originalCommit: { oid: 'abcdef1234567' } }],
	},
} as const satisfies ReviewThread

export type GitHubReply = (
	request: HttpClientRequest.HttpClientRequest,
	attempt: number
) => Effect.Effect<Response, HttpClientError.HttpClientError>

/** Captures the real client's requests while replacing all HTTP with an in-memory reply. */
export function makeGitHubHttp(reply: GitHubReply) {
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
	return {
		requests,
		layer: GitHubApiServiceLive.pipe(
			Layer.provide(
				Layer.merge(
					Layer.succeed(GitHubConfig, GITHUB_SETTINGS),
					Layer.succeed(HttpClient.HttpClient, client)
				)
			)
		),
	}
}

export type GitHubConnection = 'reviewThreads' | 'comments'

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
