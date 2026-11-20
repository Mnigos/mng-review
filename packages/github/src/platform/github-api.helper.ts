import { Effect, Predicate } from 'effect'
import {
	CLIENT_ERROR_STATUS,
	DECLINED_GRAPHQL_TYPES,
	MAX_PAGES,
	PAGE_SIZE,
	RATE_LIMIT_MESSAGE,
	READ_RETRIES,
	READ_RETRY,
	SERVER_ERROR_STATUS,
	TOO_MANY_REQUESTS_STATUS,
} from './github-api.constants'
import type { ConnectionPage } from './github-api.schema'
import { GitHubApiError } from './github.errors'

/** True for a failure worth reading again: no answer, or a 5xx. */
export function isTransient(error: GitHubApiError): boolean {
	return error.status === undefined || error.status >= SERVER_ERROR_STATUS
}

/**
 * True when GitHub answered and refused the request itself: a 4xx other than 429, or GraphQL
 * errors that are all `FORBIDDEN`, `NOT_FOUND` or `UNPROCESSABLE`. A rate limit, by status,
 * headers or message, is never a refusal: the same request may pass later.
 */
export function isDeclined(error: GitHubApiError): boolean {
	if (error.rateLimited === true || RATE_LIMIT_MESSAGE.test(error.reason))
		return false
	if (error.graphqlErrors === true) {
		const types = error.graphqlTypes ?? []
		return (
			types.length > 0 &&
			types.every(type => type !== null && DECLINED_GRAPHQL_TYPES.has(type))
		)
	}
	return (
		error.status !== undefined &&
		error.status !== TOO_MANY_REQUESTS_STATUS &&
		error.status >= CLIENT_ERROR_STATUS &&
		error.status < SERVER_ERROR_STATUS
	)
}

/** True when the answer's headers say a rate limit stopped the request. */
export function isRateLimited(
	headers: Readonly<Record<string, string>>
): boolean {
	return (
		headers['retry-after'] !== undefined ||
		headers['x-ratelimit-remaining'] === '0'
	)
}

/** A read with retries on transient failures. */
export function read<TValue>(
	effect: Effect.Effect<TValue, GitHubApiError>
): Effect.Effect<TValue, GitHubApiError> {
	return effect.pipe(
		Effect.retry({
			schedule: READ_RETRY,
			times: READ_RETRIES,
			while: isTransient,
		})
	)
}

/** The answer's GraphQL errors joined, or `undefined` when it has none. */
export function getGraphqlErrors(
	errors: readonly { readonly message: string }[] | undefined
): string | undefined {
	if (!errors || errors.length === 0) return undefined
	return errors.map(error => error.message).join('; ')
}

/**
 * Every node of a connection, page by page. A missing pull request or more than `MAX_PAGES`
 * pages fails, so a partial list is never taken for the whole; nodes GitHub could not resolve
 * are left out.
 */
export function collect<TNode>(
	operation: string,
	fetchPage: (
		cursor: string | null
	) => Effect.Effect<ConnectionPage<TNode> | undefined, GitHubApiError>,
	cursor: string | null,
	page: number
): Effect.Effect<readonly TNode[], GitHubApiError> {
	return fetchPage(cursor).pipe(
		Effect.flatMap(connection => {
			if (!connection)
				return Effect.fail(
					new GitHubApiError({
						operation,
						reason:
							'the repository or pull request is not visible to the token',
					})
				)
			const nodes = connection.nodes.filter(Predicate.isNotNull)
			const { hasNextPage, endCursor } = connection.pageInfo
			if (!hasNextPage) return Effect.succeed(nodes)
			if (!endCursor)
				return Effect.fail(
					new GitHubApiError({
						operation,
						reason: 'more pages without a cursor',
					})
				)
			if (page + 1 >= MAX_PAGES)
				return Effect.fail(
					new GitHubApiError({
						operation,
						reason: `more than ${MAX_PAGES * PAGE_SIZE} entries`,
					})
				)
			return collect(operation, fetchPage, endCursor, page + 1).pipe(
				Effect.map(rest => [...nodes, ...rest])
			)
		})
	)
}
