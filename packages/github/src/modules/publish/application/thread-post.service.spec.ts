import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { GITHUB_SETTINGS } from '../../../shared/mocks/github-http.helper'
import { bug } from '../../../shared/mocks/publish-test.helper'
import { parseFindingMarker } from '../domain/publish-marker.parser'
import type { PlannedThread } from '../domain/publish.types'
import { ThreadPostService, ThreadPostServiceLive } from './thread-post.service'

const TARGET = { pullNumber: 17, head: 'head', engineCommit: 'engine' } as const

layer(Layer.empty)('ThreadPostService', test => {
	for (const status of [undefined, 403, 422, 503])
		test.effect(
			`file post failure ${status} preserves order and continues with later files`,
			() =>
				Effect.gen(function* () {
					const fake = githubApiFake()
					const error = new GitHubApiError({
						operation: 'createReviewComment',
						reason: 'Unavailable',
						...(status === undefined ? {} : { status }),
					})
					fake.failures.comment.push(error)
					const threads = [
						{ finding: bug(), kind: 'bug', place: 'line' },
						{
							finding: bug({ path: 'src/first.ts' }),
							kind: 'bug',
							place: 'file',
						},
						{
							finding: bug({ path: 'src/second.ts' }),
							kind: 'bug',
							place: 'file',
						},
						{ finding: bug(), kind: 'bug', place: 'summary' },
						{ finding: bug(), kind: 'bug', place: 'unposted' },
					] as const satisfies readonly PlannedThread[]
					const posterLayer = ThreadPostServiceLive.pipe(
						Layer.provide(
							Layer.merge(
								fake.api,
								Layer.succeed(GitHubConfig, GITHUB_SETTINGS)
							)
						)
					)
					const posted = yield* ThreadPostService.use(service =>
						service.postFiles(TARGET, threads)
					).pipe(Effect.provide(posterLayer))
					expect(posted.map(thread => thread.place)).toEqual([
						'line',
						status === 422 ? 'summary' : 'unposted',
						'file',
						'summary',
						'unposted',
					])
					expect(posted[0]).toBe(threads[0])
					expect(posted[3]).toBe(threads[3])
					expect(fake.writes).toMatchObject([
						{
							method: 'comment',
							input: { path: 'src/first.ts', commitId: TARGET.head },
						},
						{
							method: 'comment',
							input: { path: 'src/second.ts', commitId: TARGET.head },
						},
					])
					for (const write of fake.writes) {
						if (write.method !== 'comment') continue
						expect(write.input.line).toBeUndefined()
						expect(parseFindingMarker(write.input.body)?.kind).toBe('bug')
					}
					expect(fake.threads).toHaveLength(1)
				})
		)
	test.effect(
		'successful file comments use a file subject without posting line or summary threads',
		() =>
			Effect.gen(function* () {
				const fake = githubApiFake()
				const thread = {
					finding: bug(),
					kind: 'bug',
					place: 'file',
				} as const satisfies PlannedThread
				const service = ThreadPostServiceLive.pipe(
					Layer.provide(
						Layer.merge(fake.api, Layer.succeed(GitHubConfig, GITHUB_SETTINGS))
					)
				)
				expect(
					yield* ThreadPostService.use(poster =>
						poster.postFiles(TARGET, [thread])
					).pipe(Effect.provide(service))
				).toEqual([thread])
				expect(fake.threads[0]?.subjectType).toBe('FILE')
				expect(fake.writes).toHaveLength(1)
			})
	)
})
