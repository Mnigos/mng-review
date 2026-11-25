import { setTimeout as wait } from 'node:timers/promises'
import { layer } from '@effect/vitest'
import {
	GitHubApiError,
	ListCompleteness,
	ReplyFindService,
	type RaiseScan,
	RaiseService,
	RaiseServiceLive,
	toCommitStatus,
} from '@mng-review/github'
import {
	Clock,
	Deferred,
	Duration,
	Effect,
	Fiber,
	FileSystem,
	Layer,
	Predicate,
} from 'effect'
import { TestClock, TestConsole } from 'effect/testing'
// oxlint-disable-next-line no-restricted-imports -- The regression reuses the GitHub package's fakes.
import {
	githubStatusFake,
	openPullRequest,
} from '../../../../../packages/github/src/shared/mocks/github-status-fake.helper'
// oxlint-disable-next-line no-restricted-imports -- The regression reuses the GitHub package's fakes.
import {
	SUMMARY_MARKER,
	summaryReview,
} from '../../../../../packages/github/src/shared/mocks/publish-test.helper'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import {
	RAISE_MATRIX_LIMIT,
	RAISE_SCAN_BOUND,
	RAISE_SCAN_DEADLINE,
	RAISE_SCAN_LIMIT,
	runFindStep,
} from './find-step.handler'

afterEach(() => {
	cleanupRepos()
})

/** The raise judgments over the fixture's fake GitHub, whose status fake lists no open pull request. */
function raiseLayer(fixture: Pick<ReturnType<typeof stepFixture>, 'status'>) {
	return RaiseServiceLive.pipe(Layer.provide(fixture.status.layer))
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
						Effect.provide(raiseLayer(fixture)),
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
					).toBe(`pulls=${JSON.stringify(candidates)}\nraises=[]\n`)
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
				Effect.provide(raiseLayer(fixture)),
				Effect.provide(fixture.publisherLayer),
				Effect.provide(fixture.envLayer())
			)
			expect(
				yield* (yield* FileSystem.FileSystem).readFileString(
					fixture.paths.output
				)
			).toBe('pulls=[]\nraises=[]\n')
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
					Effect.provide(raiseLayer(fixture)),
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
					`pulls=${JSON.stringify(scenario === 'partial failure' ? candidates : [])}\nraises=[]\n`
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
						Effect.provide(raiseLayer(fixture)),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(fixture.envLayer())
					)
					expect(seen).toEqual([riskEnabled])
				})
		)
})

/** A reply search that finds the candidates given, for the raise specs. */
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

layer(FileSystemLayer)('find step raises', test => {
	test.effect(
		'a pull request with replies and a due raise is in each list once, the raise judged with commands.allow',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture(undefined, false, false, ['release-owner'])
				const findDueSpy = vi.fn(
					(_allow: readonly string[], _scan?: RaiseScan) =>
						Effect.succeed({
							pulls: [17, 23],
							read: 3,
							failed: 1,
							unscanned: 0,
							deferred: 0,
						})
				)
				yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(replyFind([17], fixture.head, fixture.base)),
					Effect.provide(
						Layer.succeed(RaiseService, {
							findDue: findDueSpy,
							raise: () => Effect.die('find never raises'),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer()),
					Effect.provide(Layer.fresh(TestConsole.layer))
				)
				expect(findDueSpy).toHaveBeenCalledExactlyOnceWith(['release-owner'], {
					rotation: 0,
					deadline: Duration.toMillis(RAISE_SCAN_DEADLINE),
					bound: Duration.toMillis(RAISE_SCAN_BOUND),
					limit: RAISE_SCAN_LIMIT,
				})
				const candidates = [
					{ number: 17, base: fixture.base, head: fixture.head },
				]
				expect(
					yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.output
					)
				).toBe(
					`pulls=${JSON.stringify(candidates)}\nraises=${JSON.stringify([{ number: 17 }, { number: 23 }])}\n`
				)
				expect(fixture.api.writes).toEqual([])
			})
	)
	test.effect(
		'the line names the raises and the pull requests not judged',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(replyFind([], fixture.head, fixture.base)),
					Effect.provide(
						Layer.succeed(RaiseService, {
							findDue: () =>
								Effect.succeed({
									pulls: [23],
									read: 2,
									failed: 1,
									unscanned: 0,
									deferred: 0,
								}),
							raise: () => Effect.die('find never raises'),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer())
				)
				expect(yield* TestConsole.logLines).toEqual([
					'mng-review: reply schedule: no reply waits for an answer; a status or change request to raise on #23; 1 pull request(s) could not be judged for a raise',
				])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'more raises than one matrix holds keep the first and leave the rest for the next tick',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const pulls = Array.from(
					{ length: RAISE_MATRIX_LIMIT + 2 },
					(_, index) => index + 1
				)
				yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(replyFind([], fixture.head, fixture.base)),
					Effect.provide(
						Layer.succeed(RaiseService, {
							findDue: () =>
								Effect.succeed({
									pulls,
									read: pulls.length,
									failed: 0,
									unscanned: 0,
									deferred: 0,
								}),
							raise: () => Effect.die('find never raises'),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer()),
					Effect.provide(Layer.fresh(TestConsole.layer))
				)
				const output = yield* (yield* FileSystem.FileSystem).readFileString(
					fixture.paths.output
				)
				const raises = /^raises=(.*)$/mu.exec(output)?.[1] ?? '[]'
				expect(JSON.parse(raises)).toEqual(
					pulls.slice(0, RAISE_MATRIX_LIMIT).map(number => ({ number }))
				)
			})
	)
	test.effect(
		'more due raises than one matrix holds are capped in the order the scan judged them',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const pulls = Array.from(
					{ length: RAISE_MATRIX_LIMIT + 2 },
					(_, index) => index + 1
				)
				yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(replyFind([], fixture.head, fixture.base)),
					Effect.provide(
						Layer.succeed(RaiseService, {
							findDue: () =>
								Effect.succeed({
									pulls,
									read: pulls.length,
									failed: 0,
									unscanned: 0,
									deferred: 0,
								}),
							raise: () => Effect.die('find never raises'),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer({ GITHUB_RUN_NUMBER: '1' })),
					Effect.provide(Layer.fresh(TestConsole.layer))
				)
				const output = yield* (yield* FileSystem.FileSystem).readFileString(
					fixture.paths.output
				)
				const raises = /^raises=(.*)$/mu.exec(output)?.[1] ?? '[]'
				// The scan already started at the run number's place; a second rotation would undo it.
				expect(JSON.parse(raises)).toEqual(
					pulls.slice(0, RAISE_MATRIX_LIMIT).map(number => ({ number }))
				)
			})
	)
	test.effect(
		'every one of 257 pull requests that stay due is listed within ceil(N / stride) ticks, the stride being the limit for a prime N',
		() =>
			Effect.gen(function* () {
				const open = Array.from({ length: 257 }, (_, index) =>
					openPullRequest(index + 1, 'head')
				)
				const listed = new Set<number>()
				const ticks = Math.ceil(open.length / RAISE_SCAN_LIMIT)
				for (let tick = 0; tick < ticks; tick += 1) {
					// A fresh run of find each tick over the same pull requests, which no raise clears.
					const fixture = stepFixture()
					fixture.api.reviews.push(
						summaryReview(
							{ ...SUMMARY_MARKER, head: 'head', finished: true },
							{ databaseId: 101 }
						),
						summaryReview(
							{ ...SUMMARY_MARKER, head: 'head' },
							{
								databaseId: 102,
								state: 'CHANGES_REQUESTED',
								commit: { oid: 'head' },
							}
						)
					)
					const status = githubStatusFake({
						listOpenPullRequests: () => Effect.succeed(open),
						getStatus: () =>
							Effect.succeed({
								id: 1,
								...toCommitStatus('needs fixes', 1, true),
								context: 'MNG Review',
								creator: null,
							}),
					})
					yield* runFindStep.pipe(
						Effect.provide(fixture.rulesLayer),
						Effect.provide(replyFind([], fixture.head, fixture.base)),
						Effect.provide(RaiseServiceLive.pipe(Layer.provide(status.layer))),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(
							fixture.envLayer({ GITHUB_RUN_NUMBER: String(tick) })
						),
						Effect.provide(Layer.fresh(TestConsole.layer))
					)
					const output = yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.output
					)
					const raises: unknown = JSON.parse(
						/^raises=(.*)$/mu.exec(output)?.[1] ?? '[]'
					)
					expect(Array.isArray(raises) && raises.length).toBe(RAISE_SCAN_LIMIT)
					if (Array.isArray(raises))
						for (const entry of raises)
							if (Predicate.hasProperty(entry, 'number'))
								listed.add(Number(entry.number))
				}
				expect(listed.size).toBe(open.length)
			})
	)
	test.effect(
		'a raise judgment that never ends is cut at the bound, and the outputs, replies and judged raises stay',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				fixture.api.reviews.push(
					summaryReview(
						{ ...SUMMARY_MARKER, head: 'head', finished: true },
						{ databaseId: 101 }
					),
					summaryReview(
						{ ...SUMMARY_MARKER, head: 'head' },
						{
							databaseId: 102,
							state: 'CHANGES_REQUESTED',
							commit: { oid: 'head' },
						}
					)
				)
				const hanging = yield* Deferred.make<void>()
				const reads = { count: 0 }
				// The second pull request's status read never returns.
				const status = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed(
							[1, 2, 3].map(number => openPullRequest(number, 'head'))
						),
					getStatus: () => {
						reads.count += 1
						if (reads.count === 2)
							return Deferred.succeed(hanging, undefined).pipe(
								Effect.andThen(Effect.never)
							)
						return Effect.succeed({
							id: 1,
							...toCommitStatus('needs fixes', 1, true),
							context: 'MNG Review',
							creator: null,
						})
					},
				})
				const started = yield* Clock.currentTimeMillis
				const fiber = yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(replyFind([17], fixture.head, fixture.base)),
					Effect.provide(RaiseServiceLive.pipe(Layer.provide(status.layer))),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer()),
					Effect.forkChild
				)
				yield* Deferred.await(hanging)
				yield* TestClock.adjust(RAISE_SCAN_BOUND)
				// Done at the bound, well before the find job's five minutes; a scan that waited on the hung
				// judgment would still be running when the real-time timer ends.
				expect(
					yield* Effect.raceFirst(
						Fiber.join(fiber).pipe(Effect.as('done' as const)),
						Effect.promise(async () => await wait(2000)).pipe(
							Effect.as('still running' as const)
						)
					)
				).toBe('done')
				expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(
					Duration.toMillis(Duration.minutes(5))
				)
				const candidates = [
					{ number: 17, base: fixture.base, head: fixture.head },
				]
				expect(
					yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.output
					)
				).toBe(
					`pulls=${JSON.stringify(candidates)}\nraises=${JSON.stringify([{ number: 1 }])}\n`
				)
				expect(yield* TestConsole.logLines).toEqual([
					'::warning::the raise scan hit its hard bound while judging #2; 2 pull request(s) not judged this tick',
					'mng-review: reply schedule: replies wait on #17; a status or change request to raise on #1; 2 pull request(s) not judged for a raise before the hard bound; the raise judgment of #2 was cut at the hard bound',
				])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	for (const [cut, result, warning, line] of [
		[
			'before the listing',
			{ pulls: [], read: 0, stop: 'bound' },
			'the raise scan hit its hard bound before it listed the open pull requests; no raise this tick',
			'; the raise scan hit its hard bound before it listed the open pull requests',
		],
		[
			'between judgments',
			{ pulls: [23], read: 5, unscanned: 2, stop: 'bound' },
			'the raise scan hit its hard bound between judgments; 2 pull request(s) not judged this tick',
			'; a status or change request to raise on #23; 2 pull request(s) not judged for a raise before the hard bound',
		],
	] as const)
		test.effect(
			`a hard bound ${cut} is named in the warning and the replies stay`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					yield* runFindStep.pipe(
						Effect.provide(fixture.rulesLayer),
						Effect.provide(replyFind([17], fixture.head, fixture.base)),
						Effect.provide(
							Layer.succeed(RaiseService, {
								findDue: () =>
									Effect.succeed({
										failed: 0,
										unscanned: 0,
										deferred: 0,
										...result,
									}),
								raise: () => Effect.die('find never raises'),
							})
						),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(fixture.envLayer())
					)
					expect(yield* TestConsole.logLines).toEqual([
						`::warning::${warning}`,
						`mng-review: reply schedule: replies wait on #17${line}`,
					])
					const summary = yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.summary
					)
					expect(summary).toContain('hard bound')
					expect(summary).not.toContain('deadline')
				}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
		)
	test.effect(
		'the raise scan runs beside the reply scan with the run number and a deadline from the start',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const started = yield* Clock.currentTimeMillis
				const replying = yield* Deferred.make<void>()
				const scans: { readonly at: number; readonly scan: unknown }[] = []
				const fiber = yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					// A reply scan that takes four minutes.
					Effect.provide(
						Layer.succeed(ReplyFindService, {
							find: () =>
								Deferred.succeed(replying, undefined).pipe(
									Effect.andThen(Effect.sleep(Duration.minutes(4))),
									Effect.as({ candidates: [], read: 1, failed: 0 })
								),
							readPending: () => Effect.succeed({ threads: [], replies: [] }),
						})
					),
					Effect.provide(
						Layer.succeed(RaiseService, {
							findDue: (_allow, scan) =>
								Clock.currentTimeMillis.pipe(
									Effect.map(at => {
										scans.push({ at, scan })
										return {
											pulls: [],
											read: 0,
											failed: 0,
											unscanned: 0,
											deferred: 0,
										}
									})
								),
							raise: () => Effect.die('find never raises'),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer({ GITHUB_RUN_NUMBER: '7' })),
					Effect.forkChild
				)
				yield* Deferred.await(replying)
				yield* TestClock.adjust(Duration.minutes(4))
				yield* Fiber.join(fiber)
				// The raise scan starts at once, not after the replies.
				expect(scans).toEqual([
					{
						at: started,
						scan: {
							rotation: 7,
							deadline: started + Duration.toMillis(RAISE_SCAN_DEADLINE),
							bound: started + Duration.toMillis(RAISE_SCAN_BOUND),
							limit: RAISE_SCAN_LIMIT,
						},
					},
				])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'a raise scan past its deadline lists what it judged and warns about the rest',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(replyFind([17], fixture.head, fixture.base)),
					Effect.provide(
						Layer.succeed(RaiseService, {
							findDue: () =>
								Effect.succeed({
									pulls: [23],
									read: 5,
									failed: 0,
									unscanned: 2,
									deferred: 0,
								}),
							raise: () => Effect.die('find never raises'),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer())
				)
				const candidates = [
					{ number: 17, base: fixture.base, head: fixture.head },
				]
				expect(
					yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.output
					)
				).toBe(
					`pulls=${JSON.stringify(candidates)}\nraises=${JSON.stringify([{ number: 23 }])}\n`
				)
				expect(yield* TestConsole.logLines).toEqual([
					'::warning::the raise scan reached its deadline; 2 pull request(s) not judged this tick',
					'mng-review: reply schedule: replies wait on #17; a status or change request to raise on #23; 2 pull request(s) not judged for a raise before the deadline',
				])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'a failed list of the raises keeps the replies, lists no raise, warns and names the failure',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const completed = yield* runFindStep.pipe(
					Effect.provide(fixture.rulesLayer),
					Effect.provide(replyFind([17], fixture.head, fixture.base)),
					Effect.provide(
						Layer.succeed(RaiseService, {
							findDue: () =>
								Effect.fail(
									new GitHubApiError({
										operation: 'listOpenPullRequests',
										reason: 'unavailable',
										status: 503,
									})
								),
							raise: () => Effect.die('find never raises'),
						})
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer()),
					Effect.result
				)
				// A raise listing that fails must not skip the reply legs, which need find to pass.
				expect(completed._tag).toBe('Success')
				const candidates = [
					{ number: 17, base: fixture.base, head: fixture.head },
				]
				expect(
					yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.output
					)
				).toBe(`pulls=${JSON.stringify(candidates)}\nraises=[]\n`)
				// The warning shows on the run page, since find still passes.
				expect(yield* TestConsole.logLines).toEqual([
					'::warning::the pull requests to raise could not be listed: GitHub listOpenPullRequests failed (HTTP 503): unavailable',
					'mng-review: reply schedule: replies wait on #17; the pull requests to raise could not be listed: GitHub listOpenPullRequests failed (HTTP 503): unavailable',
				])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
})
