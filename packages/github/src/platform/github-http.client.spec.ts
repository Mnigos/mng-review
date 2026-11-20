import { layer } from '@effect/vitest'
import { Deferred, Duration, Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import {
	failGitHubTransport,
	makeGitHubHttp,
} from '../shared/mocks/github-http.helper'
import { REQUEST_TIMEOUT } from './github-api.constants'
import { GitHubApiService } from './github-api.service'

layer(Layer.empty)('GitHub HTTP GraphQL error classification', test => {
	for (const partialData of [false, true])
		test.effect(
			`GraphQL errors with ${partialData ? 'partial' : 'no'} data carry graphqlErrors true`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(
							Response.json({
								errors: [
									{ message: 'Not minimizable', type: 'UNPROCESSABLE' },
									{ message: 'Try later', type: 'RATE_LIMITED' },
									{ message: 'Unknown error' },
								],
								...(partialData ? { data: { minimizeComment: null } } : {}),
							})
						)
					)
					const failure = yield* GitHubApiService.use(service =>
						service.minimizeComment('summary-node')
					).pipe(Effect.provide(fixture.layer), Effect.flip)
					expect(failure).toMatchObject({
						operation: 'minimizeComment',
						reason: 'Not minimizable; Try later; Unknown error',
						graphqlTypes: ['UNPROCESSABLE', 'RATE_LIMITED', null],
						graphqlErrors: true,
					})
					expect(failure.status).toBeUndefined()
					expect(fixture.requests).toHaveLength(1)
				})
		)
	for (const status of [403, 503])
		test.effect(
			`HTTP ${status} on a GraphQL request does not carry graphqlErrors`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(
							Response.json(
								{
									message: 'Request failed',
									errors: [{ message: 'Not a successful GraphQL answer' }],
								},
								{ status }
							)
						)
					)
					const failure = yield* GitHubApiService.use(service =>
						service.minimizeComment('summary-node')
					).pipe(Effect.provide(fixture.layer), Effect.flip)
					expect(failure).toMatchObject({
						operation: 'minimizeComment',
						reason: 'Request failed',
						status,
					})
					expect(failure.graphqlErrors).toBeUndefined()
					expect(fixture.requests).toHaveLength(1)
				})
		)
	test.effect('a GraphQL transport failure does not carry graphqlErrors', () =>
		Effect.gen(function* () {
			const fixture = makeGitHubHttp(request => failGitHubTransport(request))
			const failure = yield* GitHubApiService.use(service =>
				service.minimizeComment('summary-node')
			).pipe(Effect.provide(fixture.layer), Effect.flip)
			expect(failure.operation).toBe('minimizeComment')
			expect(failure.graphqlErrors).toBeUndefined()
			expect(failure.status).toBeUndefined()
			expect(fixture.requests).toHaveLength(1)
		})
	)
	test.effect(
		'a GraphQL timeout does not carry graphqlErrors and interrupts the request',
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const interrupted = yield* Deferred.make<void>()
				const fixture = makeGitHubHttp(() =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
					)
				)
				const pending = yield* GitHubApiService.use(service =>
					service.minimizeComment('summary-node')
				).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild)
				yield* Deferred.await(started)
				yield* TestClock.adjust(REQUEST_TIMEOUT)
				const failure = yield* Fiber.join(pending)
				expect(failure).toMatchObject({
					operation: 'minimizeComment',
					reason: `no answer within ${Duration.format(REQUEST_TIMEOUT)}`,
				})
				expect(failure.graphqlErrors).toBeUndefined()
				expect(failure.status).toBeUndefined()
				expect(yield* Deferred.isDone(interrupted)).toBe(true)
				expect(fixture.requests).toHaveLength(1)
			})
	)
})

layer(Layer.empty)('GitHub HTTP rate limit headers', test => {
	for (const headers of Array.of<Readonly<Record<string, string>>>(
		{ 'retry-after': '60' },
		{ 'x-ratelimit-remaining': '0' },
		{},
		{ 'x-ratelimit-remaining': '1' }
	))
		test.effect(
			`HTTP 403 with ${JSON.stringify(headers)} preserves rate limit classification`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(
							Response.json(
								{ message: 'Request failed' },
								{ status: 403, headers }
							)
						)
					)
					const failure = yield* GitHubApiService.use(service =>
						service.minimizeComment('summary-node')
					).pipe(Effect.provide(fixture.layer), Effect.flip)
					expect(failure.status).toBe(403)
					expect(failure.rateLimited).toBe(
						'retry-after' in headers ||
							('x-ratelimit-remaining' in headers &&
								headers['x-ratelimit-remaining'] === '0')
							? true
							: undefined
					)
					expect(failure.graphqlErrors).toBeUndefined()
					expect(fixture.requests).toHaveLength(1)
				})
		)
})
