import { layer } from '@effect/vitest'
import { GitHubApiError, ReplyFindService } from '@mng-review/github'
import { Effect, FileSystem, Layer } from 'effect'
import { TestConsole } from 'effect/testing'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { runFindStep } from './find-step.handler'

afterEach(() => {
	cleanupRepos()
})

layer(FileSystemLayer)('find step', test => {
	for (const rotation of [undefined, 7])
		test.effect(
			`writes a JSON matrix from default-branch rules with run number ${rotation}`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const candidates = [
						{ number: 17, base: fixture.base, head: fixture.head },
					]
					const findSpy = vi.fn(() =>
						Effect.succeed({ candidates, read: 1, failed: 0 })
					)
					yield* runFindStep.pipe(
						Effect.provide(fixture.rulesLayer),
						Effect.provide(
							Layer.succeed(ReplyFindService, {
								find: findSpy,
								readPending: () => Effect.succeed({ threads: [], replies: [] }),
							})
						),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(
							fixture.envLayer({
								GITHUB_EVENT_NAME: 'schedule',
								...(rotation === undefined
									? {}
									: {
											GITHUB_RUN_NUMBER: String(rotation),
											MNG_REVIEW_MAX_PULL_REQUESTS: '3',
										}),
							})
						)
					)
					expect(fixture.loads).toEqual(['HEAD'])
					expect(findSpy).toHaveBeenCalledExactlyOnceWith({
						max: rotation === undefined ? 5 : 3,
						rotation: rotation ?? 0,
					})
					expect(
						yield* (yield* FileSystem.FileSystem).readFileString(
							fixture.paths.output
						)
					).toBe(`pulls=${JSON.stringify(candidates)}\n`)
					expect(fixture.api.writes).toEqual([])
				})
		)
	test.effect('no candidate writes the literal empty JSON array', () =>
		Effect.gen(function* () {
			const fixture = stepFixture()
			yield* runFindStep.pipe(
				Effect.provide(fixture.rulesLayer),
				Effect.provide(
					Layer.succeed(ReplyFindService, {
						find: () => Effect.succeed({ candidates: [], read: 0, failed: 0 }),
						readPending: () => Effect.succeed({ threads: [], replies: [] }),
					})
				),
				Effect.provide(fixture.publisherLayer),
				Effect.provide(fixture.envLayer())
			)
			expect(
				yield* (yield* FileSystem.FileSystem).readFileString(
					fixture.paths.output
				)
			).toBe('pulls=[]\n')
			expect(fixture.api.writes).toEqual([])
		})
	)
})

layer(FileSystemLayer)('find step failures', test => {
	for (const scenario of [
		'list error',
		'all reads fail',
		'partial failure',
	] as const)
		test.effect(`${scenario} writes the matrix and reports its outcome`, () =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const candidates = [
					{ number: 17, base: fixture.base, head: fixture.head },
				]
				const completed = yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(
						Layer.succeed(ReplyFindService, {
							find: () =>
								scenario === 'list error'
									? Effect.fail(
											new GitHubApiError({
												operation: 'listOpenPullRequests',
												reason: 'unavailable',
												status: 503,
											})
										)
									: Effect.succeed({
											candidates:
												scenario === 'partial failure' ? candidates : [],
											read: 2,
											failed: scenario === 'partial failure' ? 1 : 2,
										}),
							readPending: () => Effect.succeed({ threads: [], replies: [] }),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer()),
					Effect.result
				)
				if (scenario === 'partial failure')
					expect(completed._tag).toBe('Success')
				else
					expect(completed).toMatchObject({
						_tag: 'Failure',
						failure: { _tag: 'ActionExit', code: 1 },
					})
				const fs = yield* FileSystem.FileSystem
				expect(yield* fs.readFileString(fixture.paths.output)).toBe(
					`pulls=${JSON.stringify(scenario === 'partial failure' ? candidates : [])}\n`
				)
				const line =
					scenario === 'partial failure'
						? 'reply schedule: replies wait on #17; 1 pull request(s) could not be read'
						: scenario === 'all reads fail'
							? 'reply schedule failed: no open pull request could be read (2)'
							: 'reply schedule failed: GitHub listOpenPullRequests failed (HTTP 503): unavailable'
				const summaryLine =
					scenario === 'partial failure'
						? 'reply schedule: replies wait on `#17;` 1 pull request\\(s\\) could not be read'
						: scenario === 'all reads fail'
							? 'reply schedule failed: no open pull request could be read \\(2\\)'
							: 'reply schedule failed: GitHub listOpenPullRequests failed \\(HTTP 503\\): unavailable'
				expect(yield* fs.readFileString(fixture.paths.summary)).toContain(
					summaryLine
				)
				expect(yield* TestConsole.logLines).toEqual([`mng-review: ${line}`])
				expect(fixture.api.writes).toEqual([])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
		)
})
