import { layer } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import {
	failGitHubTransport,
	getGitHubRequestBody,
	GITHUB_CREDENTIAL,
	GITHUB_SETTINGS,
	makeGitHubHttp,
	toGitHubPage,
} from '../shared/mocks/github-http.helper'
import { summaryReview } from '../shared/mocks/publish-test.helper'
import {
	MAX_PAGES,
	PAGE_SIZE,
	PULL_REQUEST_REVIEWS_QUERY,
	PULL_REQUEST_REVIEWS_WITH_COMMITS_QUERY,
	READ_RETRIES,
} from './github-api.constants'
import { GitHubReviewService, REVIEW_EVENTS } from './github-review.service'

layer(Layer.empty)('GitHubReviewService', test => {
	for (const event of REVIEW_EVENTS)
		test.effect(
			`createReview sends ${event} and inline comments on the head side`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(Response.json({ id: 91 }, { status: 201 }))
					)
					expect(
						yield* GitHubReviewService.use(service =>
							service.createReview(42, {
								commitId: 'head',
								event,
								body: 'Review body',
								comments: [
									{ path: 'src/one.ts', line: 7, body: 'Finding' },
									{ path: 'src/two.ts', line: 19, body: 'Other finding' },
								],
							})
						).pipe(Effect.provide(fixture.reviewLayer))
					).toBe(91)
					expect(fixture.requests[0]).toMatchObject({
						method: 'POST',
						url: `${GITHUB_SETTINGS.apiUrl}/repos/${GITHUB_SETTINGS.owner}/${GITHUB_SETTINGS.name}/pulls/42/reviews`,
						headers: { authorization: `Bearer ${GITHUB_CREDENTIAL}` },
					})
					expect(getGitHubRequestBody(fixture.requests[0])).toEqual({
						commit_id: 'head',
						event,
						body: 'Review body',
						comments: [
							{ path: 'src/one.ts', line: 7, side: 'RIGHT', body: 'Finding' },
							{
								path: 'src/two.ts',
								line: 19,
								side: 'RIGHT',
								body: 'Other finding',
							},
						],
					})
					expect(fixture.requests).toHaveLength(1)
				})
		)
	test.effect('updateReview uses PUT with only the body and returns void', () =>
		Effect.gen(function* () {
			const fixture = makeGitHubHttp(() =>
				Effect.succeed(Response.json({ id: 91 }))
			)
			expect(
				yield* GitHubReviewService.use(service =>
					service.updateReview(42, 91, 'Revised body')
				).pipe(Effect.provide(fixture.reviewLayer))
			).toBeUndefined()
			expect(fixture.requests[0]).toMatchObject({
				method: 'PUT',
				url: `${GITHUB_SETTINGS.apiUrl}/repos/${GITHUB_SETTINGS.owner}/${GITHUB_SETTINGS.name}/pulls/42/reviews/91`,
			})
			expect(getGitHubRequestBody(fixture.requests[0])).toEqual({
				body: 'Revised body',
			})
		})
	)
	for (const operation of ['createReview', 'updateReview'] as const)
		for (const kind of [
			'transport',
			'server',
			'schema',
			'json',
			'refused',
		] as const)
			test.effect(`${operation} never retries ${kind} failures`, () =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(request => {
						if (kind === 'transport') return failGitHubTransport(request)
						if (kind === 'server')
							return Effect.succeed(
								Response.json({ message: 'Unavailable' }, { status: 503 })
							)
						if (kind === 'refused')
							return Effect.succeed(
								Response.json({ message: 'Invalid review' }, { status: 422 })
							)
						if (kind === 'json')
							return Effect.succeed(new Response('invalid json'))
						return Effect.succeed(Response.json({ id: 'invalid' }))
					})
					const error = yield* GitHubReviewService.use(service =>
						operation === 'createReview'
							? service
									.createReview(42, {
										commitId: 'head',
										event: 'COMMENT',
										body: 'Review',
										comments: [],
									})
									.pipe(Effect.asVoid)
							: service.updateReview(42, 91, 'Review')
					).pipe(Effect.provide(fixture.reviewLayer), Effect.flip)
					expect(error.operation).toBe(operation)
					expect(error.message).not.toContain(GITHUB_CREDENTIAL)
					expect(fixture.requests).toHaveLength(1)
				})
			)
	test.effect(
		'listReviews paginates with a cursor and retains hidden dismissed reviews',
		() =>
			Effect.gen(function* () {
				const first = summaryReview()
				const second = summaryReview(undefined, {
					id: 'dismissed',
					databaseId: 102,
					isMinimized: true,
					state: 'DISMISSED',
				})
				const fixture = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(
						Response.json(
							toGitHubPage(
								'reviews',
								attempt === 1 ? [first] : [second],
								attempt === 1,
								attempt === 1 ? 'next' : null
							)
						)
					)
				)
				expect(
					yield* GitHubReviewService.use(service =>
						service.listReviews(42)
					).pipe(Effect.provide(fixture.reviewLayer))
				).toEqual([first, second])
				expect(
					fixture.requests.map(request => getGitHubRequestBody(request))
				).toEqual(
					[null, 'next'].map(cursor => ({
						query: PULL_REQUEST_REVIEWS_QUERY,
						variables: {
							owner: GITHUB_SETTINGS.owner,
							name: GITHUB_SETTINGS.name,
							number: 42,
							cursor,
						},
					}))
				)
				expect(
					fixture.requests.every(
						request => request.url === GITHUB_SETTINGS.graphqlUrl
					)
				).toBe(true)
			})
	)
	test.effect(
		'listReviews fails on a review GitHub lists as a null node, since it may hold a rating',
		() =>
			Effect.gen(function* () {
				const fixture = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(
						Response.json(
							toGitHubPage(
								'reviews',
								attempt === 1 ? [summaryReview()] : [null],
								attempt === 1,
								attempt === 1 ? 'next' : null
							)
						)
					)
				)
				expect(
					yield* GitHubReviewService.use(service =>
						service.listReviews(42)
					).pipe(Effect.provide(fixture.reviewLayer), Effect.flip)
				).toMatchObject({ _tag: 'GitHubApiError', operation: 'listReviews' })
			})
	)
	for (const status of [403, 404, 422, 429])
		test.effect(`listReviews preserves HTTP ${status} without retrying`, () =>
			Effect.gen(function* () {
				const fixture = makeGitHubHttp(() =>
					Effect.succeed(Response.json({ message: 'Denied' }, { status }))
				)
				expect(
					yield* GitHubReviewService.use(service =>
						service.listReviews(42)
					).pipe(Effect.provide(fixture.reviewLayer), Effect.flip)
				).toMatchObject({ operation: 'listReviews', status, reason: 'Denied' })
				expect(fixture.requests).toHaveLength(1)
			})
		)
	test.effect(
		'listReviews retries a transient read and then returns the complete list',
		() =>
			Effect.gen(function* () {
				const review = summaryReview()
				const fixture = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(
						attempt === 1
							? Response.json({ message: 'Unavailable' }, { status: 503 })
							: Response.json(toGitHubPage('reviews', [review]))
					)
				)
				const pending = yield* GitHubReviewService.use(service =>
					service.listReviews(42)
				).pipe(Effect.provide(fixture.reviewLayer), Effect.forkChild)
				yield* TestClock.adjust('10 seconds')
				expect(yield* Fiber.join(pending)).toEqual([review])
				expect(fixture.requests).toHaveLength(2)
			})
	)
	test.effect(
		'listReviews rejects malformed successful responses after bounded retries',
		() =>
			Effect.gen(function* () {
				const fixture = makeGitHubHttp(() =>
					Effect.succeed(
						Response.json(
							toGitHubPage('reviews', [
								{ ...summaryReview(), state: 'INVALID' },
							])
						)
					)
				)
				const pending = yield* GitHubReviewService.use(service =>
					service.listReviews(42)
				).pipe(
					Effect.provide(fixture.reviewLayer),
					Effect.flip,
					Effect.forkChild
				)
				yield* TestClock.adjust('10 seconds')
				expect(yield* Fiber.join(pending)).toMatchObject({
					operation: 'listReviews',
					reason: 'unexpected answer',
				})
				expect(fixture.requests).toHaveLength(READ_RETRIES + 1)
			})
	)
	test.effect(
		'listReviews fails instead of returning a truncated page without a cursor',
		() =>
			Effect.gen(function* () {
				const fixture = makeGitHubHttp(() =>
					Effect.succeed(
						Response.json(
							toGitHubPage('reviews', [summaryReview()], true, null)
						)
					)
				)
				expect(
					yield* GitHubReviewService.use(service =>
						service.listReviews(42)
					).pipe(Effect.provide(fixture.reviewLayer), Effect.flip)
				).toMatchObject({ operation: 'listReviews' })
				expect(fixture.requests).toHaveLength(1)
			})
	)
	test.effect('listReviews refuses more than the configured page bound', () =>
		Effect.gen(function* () {
			const fixture = makeGitHubHttp((_request, attempt) =>
				Effect.succeed(
					Response.json(
						toGitHubPage(
							'reviews',
							[summaryReview()],
							true,
							`cursor-${attempt}`
						)
					)
				)
			)
			const error = yield* GitHubReviewService.use(service =>
				service.listReviews(42)
			).pipe(Effect.provide(fixture.reviewLayer), Effect.flip)
			expect(error.reason).toContain(String(MAX_PAGES * PAGE_SIZE))
			expect(fixture.requests).toHaveLength(MAX_PAGES)
		})
	)
})

layer(Layer.empty)('GitHubReviewService commit query', test => {
	for (const withCommits of [false, true])
		test.effect(
			`listReviews withCommits=${withCommits} selects the appropriate GraphQL query`,
			() =>
				Effect.gen(function* () {
					const review = summaryReview(undefined, {
						commit: { oid: 'reviewed-head' },
					})
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(Response.json(toGitHubPage('reviews', [review])))
					)
					expect(
						yield* GitHubReviewService.use(service =>
							service.listReviews(17, withCommits)
						).pipe(Effect.provide(fixture.reviewLayer))
					).toEqual([review])
					expect(getGitHubRequestBody(fixture.requests[0])).toMatchObject({
						query: withCommits
							? PULL_REQUEST_REVIEWS_WITH_COMMITS_QUERY
							: PULL_REQUEST_REVIEWS_QUERY,
					})
					expect(PULL_REQUEST_REVIEWS_WITH_COMMITS_QUERY).toMatch(
						/commit\s*\{\s*oid\s*\}/u
					)
					expect(PULL_REQUEST_REVIEWS_QUERY).not.toMatch(/\bcommit\b/u)
				})
		)
})
