import { Effect, Predicate } from 'effect'
import {
	CLIENT_ERROR_STATUS,
	MAX_PAGES,
	PAGE_SIZE,
	READ_RETRIES,
	READ_RETRY,
	SERVER_ERROR_STATUS,
} from './github-api.constants'
import type { ConnectionPage } from './github-api.schema'
import { GitHubApiError } from './github.errors'

/** True for a failure worth reading again: no answer, or a 5xx. */
export function isTransient(error: GitHubApiError): boolean {
	return error.status === undefined || error.status >= SERVER_ERROR_STATUS
}

/** True when GitHub answered and declined the request: a 4xx, or GraphQL errors. */
export function isDeclined(error: GitHubApiError): boolean {
	if (error.graphqlErrors === true) return true
	return (
		error.status !== undefined &&
		error.status >= CLIENT_ERROR_STATUS &&
		error.status < SERVER_ERROR_STATUS
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
