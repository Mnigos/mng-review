import { REDACTED } from '@mng-review/engine'
import { Duration, Effect, Predicate, Redacted, Schema } from 'effect'
import {
	HttpClient,
	HttpClientRequest,
	type HttpClientResponse,
} from 'effect/http'
import { API_VERSION, REQUEST_TIMEOUT } from './github-api.constants'
import { getGraphqlErrors, read } from './github-api.helper'
import { errorBodySchema } from './github-api.schema'
import { GitHubConfig } from './github.config'
import { GitHubApiError } from './github.errors'

/** A GraphQL answer: its errors, whatever the data. */
interface GraphqlAnswer {
	readonly errors?: readonly { readonly message: string }[] | undefined
}

/** Gives the exchange `REQUEST_TIMEOUT` and turns any other failure into a `GitHubApiError`. */
function withTimeout<TValue, TError>(
	operation: string,
	exchange: Effect.Effect<TValue, TError>
): Effect.Effect<TValue, GitHubApiError> {
	return exchange.pipe(
		Effect.timeout(REQUEST_TIMEOUT),
		Effect.mapError(error => {
			if (error instanceof GitHubApiError) return error
			if (Predicate.isTagged(error, 'TimeoutError'))
				return new GitHubApiError({
					operation,
					reason: `no answer within ${Duration.format(REQUEST_TIMEOUT)}`,
				})
			return new GitHubApiError({ operation, reason: 'unexpected answer' })
		})
	)
}

/**
 * Requests to the configured GitHub with the token, the API version and a timeout: REST through
 * `send` and `sendJson`, GraphQL through `graphql` (sent once) and `query` (retried like every
 * read). A non-2xx answer or GraphQL errors fail with GitHub's message, the token replaced.
 */
export const makeGitHubHttp = Effect.gen(function* () {
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
					error => new GitHubApiError({ operation, reason: error.reason._tag })
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
		withTimeout(
			operation,
			send(operation, request).pipe(
				Effect.flatMap(response => response.json),
				Effect.flatMap(Schema.decodeUnknownEffect(schema))
			)
		)

	/** Sends a request whose answer has no body, such as a `DELETE`, within `REQUEST_TIMEOUT`. */
	const sendEmpty = (
		operation: string,
		request: HttpClientRequest.HttpClientRequest
	): Effect.Effect<void, GitHubApiError> =>
		withTimeout(operation, send(operation, request).pipe(Effect.asVoid))

	/** A GraphQL request, sent once; errors beside data fail it. */
	const graphql = <TAnswer extends GraphqlAnswer>(
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
							new GitHubApiError({
								operation,
								reason: toSafeReason(errors),
								graphqlErrors: true,
							})
						)
			})
		)

	/** A GraphQL query, retried like every read. */
	const query = <TAnswer extends GraphqlAnswer>(
		operation: string,
		text: string,
		variables: Record<string, unknown>,
		schema: Schema.Decoder<TAnswer>
	): Effect.Effect<TAnswer, GitHubApiError> =>
		read(graphql(operation, text, variables, schema))

	return { config, repo, send, sendJson, sendEmpty, graphql, query }
})
