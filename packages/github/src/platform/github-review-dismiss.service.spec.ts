import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
	failGitHubTransport,
	getGitHubRequestBody,
	GITHUB_SETTINGS,
	makeGitHubHttp,
} from '../shared/mocks/github-http.helper'
import { GitHubReviewService } from './github-review.service'

layer(Layer.empty)('GitHubReviewService.dismissReview', test => {
	test.effect(
		'sends PUT to the exact review dismissal endpoint with message and DISMISS',
		() =>
			Effect.gen(function* () {
				const fixture = makeGitHubHttp(() =>
					Effect.succeed(Response.json({ id: 91 }))
				)
				expect(
					yield* GitHubReviewService.use(service =>
						service.dismissReview(42, 91, 'No open bugs on head abc123.')
					).pipe(Effect.provide(fixture.reviewLayer))
				).toBeUndefined()
				expect(fixture.requests).toHaveLength(1)
				expect(fixture.requests[0]).toMatchObject({
					method: 'PUT',
					url: `${GITHUB_SETTINGS.apiUrl}/repos/${GITHUB_SETTINGS.owner}/${GITHUB_SETTINGS.name}/pulls/42/reviews/91/dismissals`,
				})
				expect(getGitHubRequestBody(fixture.requests[0])).toEqual({
					message: 'No open bugs on head abc123.',
					event: 'DISMISS',
				})
			})
	)
	for (const kind of [
		'transport',
		'server',
		'refused',
		'schema',
		'json',
	] as const)
		test.effect(`does not retry a ${kind} dismissal failure`, () =>
			Effect.gen(function* () {
				const fixture = makeGitHubHttp(request => {
					if (kind === 'transport') return failGitHubTransport(request)
					if (kind === 'server')
						return Effect.succeed(
							Response.json({ message: 'Unavailable' }, { status: 503 })
						)
					if (kind === 'refused')
						return Effect.succeed(
							Response.json({ message: 'Denied' }, { status: 403 })
						)
					if (kind === 'json')
						return Effect.succeed(new Response('invalid json'))
					return Effect.succeed(Response.json({ id: 'invalid' }))
				})
				expect(
					yield* GitHubReviewService.use(service =>
						service.dismissReview(42, 91, 'No open bugs.')
					).pipe(Effect.provide(fixture.reviewLayer), Effect.flip)
				).toMatchObject({ operation: 'dismissReview' })
				expect(fixture.requests).toHaveLength(1)
			})
		)
})
