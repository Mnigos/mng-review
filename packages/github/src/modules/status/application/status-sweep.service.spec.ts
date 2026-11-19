import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { githubStatusFake } from '../../../shared/mocks/github-status-fake.helper'
import { reviewThread, bug } from '../../../shared/mocks/publish-test.helper'
import { UNFINISHED_NOTE } from '../domain/status.helper'
import {
	StatusSweepService,
	StatusSweepServiceLive,
} from './status-sweep.service'

layer(Layer.empty)('StatusSweepService', test => {
	test.effect(
		'heads without a bot status are skipped without reading their threads',
		() =>
			Effect.gen(function* () {
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([{ number: 1, head: { sha: 'unknown' } }]),
				})
				const api = githubApiFake()
				const listReviewThreadsSpy = vi.fn(() =>
					Effect.die('unreviewed pull must not be read')
				)
				const apiLayer = Layer.effect(
					GitHubApiService,
					GitHubApiService.pipe(
						Effect.map(service => ({
							...service,
							listReviewThreads: listReviewThreadsSpy,
						}))
					)
				).pipe(Layer.provide(api.api))
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fake.layer, apiLayer))
							)
						)
					)
				).toEqual({ checked: 0, updated: 0, failed: 0 })
				expect(listReviewThreadsSpy).not.toHaveBeenCalled()
				expect(fake.statuses).toEqual([])
			})
	)
	for (const kind of [
		'resolved',
		'unverified',
		'nit',
		'foreign',
		'edited',
		'open',
	] as const)
		test.effect(`sweep counts ${kind} threads`, () =>
			Effect.gen(function* () {
				const api = githubApiFake()
				const thread = reviewThread(
					{
						finding: bug(),
						kind: kind === 'unverified' || kind === 'nit' ? kind : 'bug',
					},
					{ isResolved: kind === 'resolved' }
				)
				api.threads.push(
					kind === 'foreign' || kind === 'edited'
						? {
								...thread,
								comments: {
									...thread.comments,
									nodes: thread.comments.nodes.map(comment => ({
										...comment,
										...(kind === 'foreign'
											? { author: { __typename: 'User', login: 'contributor' } }
											: {
													editor: { __typename: 'User', login: 'contributor' },
												}),
									})),
								},
							}
						: thread
				)
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([{ number: 1, head: { sha: 'head' } }]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							state: 'failure',
							description: 'stale',
							context: 'MNG Review',
							creator: { login: 'github-actions[bot]', type: 'Bot' },
						}),
				})
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fake.layer, api.api))
							)
						)
					)
				).toEqual({ checked: 1, updated: 1, failed: 0 })
				expect(fake.statuses).toContainEqual(
					expect.objectContaining({
						sha: 'head',
						state: kind === 'open' ? 'failure' : 'success',
					})
				)
				expect(api.writes).toEqual([])
			})
		)
	for (const failureAt of ['read', 'write'] as const)
		test.effect(
			`a failed ${failureAt} counts as failed and does not stop the next pull`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake()
					const error = new GitHubApiError({
						operation: failureAt,
						reason: 'denied',
						status: 403,
					})
					const fake = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([
								{ number: 1, head: { sha: 'first' } },
								{ number: 2, head: { sha: 'second' } },
							]),
						getStatus: sha =>
							failureAt === 'read' && sha === 'first'
								? Effect.fail(error)
								: Effect.succeed({
										id: 1,
										state: 'failure',
										description: null,
										context: 'MNG Review',
										creator: null,
									}),
						setStatus: input =>
							failureAt === 'write' && input.sha === 'first'
								? Effect.fail(error)
								: Effect.void,
					})
					expect(
						yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fake.layer, api.api))
								)
							)
						)
					).toEqual({ checked: 2, updated: 1, failed: 1 })
					expect(fake.statuses).toContainEqual(
						expect.objectContaining({ sha: 'second', state: 'success' })
					)
				})
		)
})

layer(Layer.empty)('StatusSweepService latest status', test => {
	for (const latest of ['same', 'newer', 'gone', 'read-failed'] as const)
		test.effect(
			`a ${latest} status at the second read controls the write`,
			() =>
				Effect.gen(function* () {
					const previous = {
						id: 1,
						state: 'failure',
						description: 'stale',
						context: 'MNG Review',
						creator: null,
					}
					const getStatusSpy = vi
						.fn()
						.mockReturnValueOnce(Effect.succeed(previous))
						.mockReturnValueOnce(
							latest === 'read-failed'
								? Effect.fail(
										new GitHubApiError({ operation: 'read', reason: 'denied' })
									)
								: Effect.succeed(
										latest === 'gone'
											? undefined
											: { ...previous, id: latest === 'newer' ? 2 : 1 }
									)
						)
					const fake = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([{ number: 17, head: { sha: 'head' } }]),
						getStatus: getStatusSpy,
					})
					const api = githubApiFake()
					expect(
						yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fake.layer, api.api))
								)
							)
						)
					).toEqual({
						checked: 1,
						updated: latest === 'same' ? 1 : 0,
						failed: latest === 'read-failed' ? 1 : 0,
					})
					expect(getStatusSpy.mock.calls).toEqual([['head'], ['head']])
					expect(api.threadReads).toEqual([17])
					expect(fake.statuses).toEqual(
						latest === 'same'
							? [
									{
										sha: 'head',
										state: 'success',
										description: 'no open bug thread',
									},
								]
							: []
					)
				})
		)
	test.effect(
		'resolving the last bug from an unfinished run never sweeps it green',
		() =>
			Effect.gen(function* () {
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([{ number: 17, head: { sha: 'head' } }]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							state: 'failure',
							description: `1 open bug thread(s); needs fixes; ${UNFINISHED_NOTE}`,
							context: 'MNG Review',
							creator: null,
						}),
				})
				const api = githubApiFake()
				api.threads.push(reviewThread(undefined, { isResolved: true }))
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fake.layer, api.api))
							)
						)
					)
				).toEqual({ checked: 1, updated: 1, failed: 0 })
				expect(fake.statuses).toEqual([
					{
						sha: 'head',
						state: 'error',
						description: `no open bug thread; ${UNFINISHED_NOTE}`,
					},
				])
			})
	)
})
