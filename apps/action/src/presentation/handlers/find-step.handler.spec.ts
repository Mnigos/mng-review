import { layer } from '@effect/vitest'
import {
	GitHubApiError,
	ListCompleteness,
	ReplyFindService,
	RequestLiftService,
	RequestLiftServiceLive,
} from '@mng-review/github'
import { Effect, FileSystem, Layer } from 'effect'
import { TestConsole } from 'effect/testing'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { LIFT_MATRIX_LIMIT, runFindStep } from './find-step.handler'

afterEach(() => {
	cleanupRepos()
})

/** The lift judgments over the fixture's fake GitHub, whose status fake lists no open pull request. */
function liftLayer(fixture: Pick<ReturnType<typeof stepFixture>, 'status'>) {
	return RequestLiftServiceLive.pipe(Layer.provide(fixture.status.layer))
}

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
						Effect.provide(liftLayer(fixture)),
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
					).toBe(`pulls=${JSON.stringify(candidates)}\nlifts=[]\n`)
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
				Effect.provide(liftLayer(fixture)),
				Effect.provide(fixture.publisherLayer),
				Effect.provide(fixture.envLayer())
			)
			expect(
				yield* (yield* FileSystem.FileSystem).readFileString(
					fixture.paths.output
				)
			).toBe('pulls=[]\nlifts=[]\n')
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
					Effect.provide(liftLayer(fixture)),
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
					`pulls=${JSON.stringify(scenario === 'partial failure' ? candidates : [])}\nlifts=[]\n`
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

layer(FileSystemLayer)('find step list completeness', test => {
	for (const riskEnabled of [false, true])
		test.effect(
			`reads complete lists only while the rules rate: ${riskEnabled}`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture(
						undefined,
						false,
						false,
						undefined,
						undefined,
						undefined,
						riskEnabled
					)
					const seen: boolean[] = []
					const findSpy = vi.fn(() =>
						ListCompleteness.pipe(
							Effect.map(reading => {
								seen.push(reading.complete)
								return { candidates: [], read: 0, failed: 0 }
							})
						)
					)
					yield* runFindStep.pipe(
						Effect.provide(fixture.rulesLayer),
						Effect.provide(
							Layer.succeed(ReplyFindService, {
								find: findSpy,
								readPending: () => Effect.succeed({ threads: [], replies: [] }),
							})
						),
						Effect.provide(liftLayer(fixture)),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(fixture.envLayer())
					)
					expect(seen).toEqual([riskEnabled])
				})
		)
})

/** A reply search that finds the candidates given, for the lift specs. */
function replyFind(numbers: readonly number[], head: string, base: string) {
	return Layer.succeed(ReplyFindService, {
		find: () =>
			Effect.succeed({
				candidates: numbers.map(number => ({ number, base, head })),
				read: 1,
				failed: 0,
			}),
		readPending: () => Effect.succeed({ threads: [], replies: [] }),
	})
}

layer(FileSystemLayer)('find step lifts', test => {
	test.effect(
		'a pull request with replies and a due lift is in each list once, the lift judged with commands.allow',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture(undefined, false, false, ['release-owner'])
				const findDueSpy = vi.fn((_allow: readonly string[]) =>
					Effect.succeed({ pulls: [17, 23], read: 3, failed: 1 })
				)
				yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(replyFind([17], fixture.head, fixture.base)),
					Effect.provide(
						Layer.succeed(RequestLiftService, {
							findDue: findDueSpy,
							lift: () => Effect.die('find never lifts'),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer()),
					Effect.provide(Layer.fresh(TestConsole.layer))
				)
				expect(findDueSpy).toHaveBeenCalledExactlyOnceWith(['release-owner'])
				const candidates = [
					{ number: 17, base: fixture.base, head: fixture.head },
				]
				expect(
					yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.output
					)
				).toBe(
					`pulls=${JSON.stringify(candidates)}\nlifts=${JSON.stringify([{ number: 17 }, { number: 23 }])}\n`
				)
				expect(fixture.api.writes).toEqual([])
			})
	)
	test.effect('the line names the lifts and the pull requests not judged', () =>
		Effect.gen(function* () {
			const fixture = stepFixture()
			yield* runFindStep.pipe(
				Effect.provide(fixture.rulesLayer),
				Effect.provide(replyFind([], fixture.head, fixture.base)),
				Effect.provide(
					Layer.succeed(RequestLiftService, {
						findDue: () => Effect.succeed({ pulls: [23], read: 2, failed: 1 }),
						lift: () => Effect.die('find never lifts'),
					})
				),
				Effect.provide(fixture.publisherLayer),
				Effect.provide(fixture.envLayer())
			)
			expect(yield* TestConsole.logLines).toEqual([
				'mng-review: reply schedule: no reply waits for an answer; a change request to lift on #23; 1 pull request(s) could not be judged for a lift',
			])
		}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'more lifts than one matrix holds keep the first and leave the rest for the next tick',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const pulls = Array.from(
					{ length: LIFT_MATRIX_LIMIT + 2 },
					(_, index) => index + 1
				)
				yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(replyFind([], fixture.head, fixture.base)),
					Effect.provide(
						Layer.succeed(RequestLiftService, {
							findDue: () =>
								Effect.succeed({ pulls, read: pulls.length, failed: 0 }),
							lift: () => Effect.die('find never lifts'),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer()),
					Effect.provide(Layer.fresh(TestConsole.layer))
				)
				const output = yield* (yield* FileSystem.FileSystem).readFileString(
					fixture.paths.output
				)
				const lifts = /^lifts=(.*)$/mu.exec(output)?.[1] ?? '[]'
				expect(JSON.parse(lifts)).toEqual(
					pulls.slice(0, LIFT_MATRIX_LIMIT).map(number => ({ number }))
				)
			})
	)
	test.effect(
		'a failed list of the lifts keeps the replies, lists no lift and names the failure',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const completed = yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(replyFind([17], fixture.head, fixture.base)),
					Effect.provide(
						Layer.succeed(RequestLiftService, {
							findDue: () =>
								Effect.fail(
									new GitHubApiError({
										operation: 'listOpenPullRequests',
										reason: 'unavailable',
										status: 503,
									})
								),
							lift: () => Effect.die('find never lifts'),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer()),
					Effect.result
				)
				// A lift listing that fails must not skip the reply legs, which need find to pass.
				expect(completed._tag).toBe('Success')
				const candidates = [
					{ number: 17, base: fixture.base, head: fixture.head },
				]
				expect(
					yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.output
					)
				).toBe(`pulls=${JSON.stringify(candidates)}\nlifts=[]\n`)
				expect(yield* TestConsole.logLines).toEqual([
					'mng-review: reply schedule: replies wait on #17; the change requests to lift could not be listed: GitHub listOpenPullRequests failed (HTTP 503): unavailable',
				])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
})
