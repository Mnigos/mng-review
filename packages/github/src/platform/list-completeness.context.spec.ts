import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import type { ConnectionPage } from './github-api.schema'
import { GitHubApiError } from './github.errors'
import {
	collectListed,
	getIncompleteLists,
	isReadIncomplete,
	type ListOperation,
	provideListCompleteness,
	readListed,
	restartListCount,
} from './list-completeness.context'

/**
 * A list read over `pages`, one per request, each followed by the next until the last; a page
 * that is `undefined` fails its request.
 */
function listOf(
	pages: readonly (readonly (string | null)[] | undefined)[],
	operation: ListOperation = 'listReviews'
) {
	return collectListed(operation, cursor => {
		const index = cursor === null ? 0 : Number(cursor)
		const last = index === pages.length - 1
		const page = pages[index]
		if (!page)
			return Effect.fail(
				new GitHubApiError({ operation, reason: 'GitHub refused the page' })
			)
		return Effect.succeed({
			nodes: pages[index] ?? [],
			pageInfo: {
				hasNextPage: !last,
				endCursor: last ? null : String(index + 1),
			},
		} satisfies ConnectionPage<string>)
	})
}

layer(Layer.empty)('ListCompleteness', test => {
	test.effect(
		'a lenient read with null nodes on any page marks the run incomplete',
		() =>
			Effect.gen(function* () {
				expect(
					yield* Effect.gen(function* () {
						const nodes = yield* listOf([
							['a', null],
							['b', null],
						])
						return { nodes, incomplete: yield* isReadIncomplete }
					}).pipe(provideListCompleteness(false))
				).toEqual({ nodes: ['a', 'b'], incomplete: true })
			})
	)
	test.effect('a lenient read without null nodes leaves the run complete', () =>
		Effect.gen(function* () {
			expect(
				yield* listOf([['a'], ['b']]).pipe(
					Effect.andThen(isReadIncomplete),
					provideListCompleteness(false)
				)
			).toBe(false)
		})
	)
	test.effect('a complete read fails on a null node and marks nothing', () =>
		Effect.gen(function* () {
			expect(
				yield* listOf([['a', null]]).pipe(
					Effect.flip,
					Effect.andThen(error =>
						isReadIncomplete.pipe(
							Effect.map(incomplete => ({ error: error.reason, incomplete }))
						)
					),
					provideListCompleteness(true)
				)
			).toEqual({
				error: 'GitHub listed an entry as a null node',
				incomplete: false,
			})
		})
	)
	test.effect(
		'an unprovided run reads complete lists and is never incomplete',
		() =>
			Effect.gen(function* () {
				expect(yield* Effect.flip(listOf([[null]]))).toMatchObject({
					_tag: 'GitHubApiError',
				})
				expect(yield* isReadIncomplete).toBe(false)
			})
	)
	test.effect('each run of a provided effect starts its own count', () =>
		Effect.gen(function* () {
			const run = Effect.gen(function* () {
				const before = yield* isReadIncomplete
				yield* listOf([[null]])
				return before
			}).pipe(provideListCompleteness(false))
			expect([yield* run, yield* run]).toEqual([false, false])
		})
	)
	test.effect('readListed says whether its own read left a node out', () =>
		Effect.gen(function* () {
			expect(
				yield* Effect.all([
					readListed(listOf([['a']])),
					readListed(listOf([['b', null]])),
					readListed(listOf([['c']])),
				]).pipe(provideListCompleteness(false))
			).toEqual([
				{ value: ['a'], incomplete: false },
				{ value: ['b'], incomplete: true },
				{ value: ['c'], incomplete: false },
			])
		})
	)
	test.effect(
		'restartListCount counts apart from the run and keeps its reading',
		() =>
			Effect.gen(function* () {
				expect(
					yield* Effect.gen(function* () {
						const inner = yield* listOf([[null]]).pipe(
							Effect.andThen(isReadIncomplete),
							restartListCount
						)
						return { inner, outer: yield* isReadIncomplete }
					}).pipe(provideListCompleteness(false))
				).toEqual({ inner: true, outer: false })
				expect(
					yield* listOf([[null]]).pipe(
						Effect.andThen(isReadIncomplete.pipe(restartListCount)),
						provideListCompleteness(false)
					)
				).toBe(false)
				expect(
					yield* listOf([[null]]).pipe(
						restartListCount,
						Effect.flip,
						provideListCompleteness(true)
					)
				).toMatchObject({ _tag: 'GitHubApiError' })
			})
	)
	test.effect(
		'a null node on a page counts when a later page of the read fails',
		() =>
			Effect.gen(function* () {
				expect(
					yield* listOf([['a', null], undefined]).pipe(
						Effect.flip,
						Effect.andThen(isReadIncomplete),
						provideListCompleteness(false)
					)
				).toBe(true)
			})
	)
	test.effect(
		'getIncompleteLists names each list that left a node out once',
		() =>
			Effect.gen(function* () {
				expect(
					yield* Effect.gen(function* () {
						yield* listOf([[null, null]], 'listReviews')
						yield* listOf([['a']], 'listComments')
						yield* listOf([[null]], 'listReviewThreads')
						yield* listOf([[null]], 'listReviews')
						return yield* getIncompleteLists
					}).pipe(provideListCompleteness(false))
				).toEqual(['review threads', 'reviews'])
			})
	)
})
