import { layer } from '@effect/vitest'
import { GitService } from '@mng-review/engine'
import { Effect, Layer, Redacted } from 'effect'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { githubStatusFake } from '../../../shared/mocks/github-status-fake.helper'
import {
	bug,
	botClosedReviewThread,
	agentReport,
	report,
	RULES,
	reviewThread,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import {
	StatusSweepService,
	StatusSweepServiceLive,
} from '../../status/application/status-sweep.service'
import { toCommitStatus } from '../../status/domain/status.helper'
import {
	parseSummaryMarker,
	parseFindingMarker,
} from '../domain/publish-marker.parser'
import { BOT_LOGIN, SHORT_SHA_LENGTH } from '../domain/publish.constants'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import { PublishService, PublishServiceLive } from './publish.service'
import { ThreadRecheckService } from './thread-recheck.service'

/** Real git history with a finding on a changed head line and a recording API. */
function setup(
	recheck: ThreadRecheckService['Service']['recheck'] = () =>
		Effect.succeed({ resolved: [], checked: 0, tokens: undefined })
) {
	const repo = createRepo()
	const original = `${Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
	repo.write(bug().path, original)
	const base = repo.commit()
	repo.write(bug().path, original.replace('line 10\n', 'changed 10\n'))
	const head = repo.commit()
	const fake = githubApiFake()
	const dependencies = Layer.mergeAll(
		fake.api,
		Layer.succeed(ThreadRecheckService, { recheck }),
		Layer.succeed(GitHubConfig, {
			serverUrl: 'https://github.com',
			apiUrl: 'https://api.github.com',
			graphqlUrl: 'https://api.github.com/graphql',
			owner: 'example',
			name: 'project',
			token: Redacted.make('fixture'),
		})
	)
	const publisher = PublishServiceLive.pipe(
		Layer.provide(Layer.merge(dependencies, gitLayer(repo.root)))
	)
	const input = {
		pullNumber: 17,
		pr: { labels: [], draft: false, fork: false, trigger: 'auto' as const },
		head,
		engineCommit: 'engine',
		rules: RULES,
		report: {
			...report(),
			planReport: {
				...report().planReport,
				change: {
					base: { ref: 'main', commit: base },
					head: { ref: 'HEAD', commit: head },
					mergeBase: base,
					files: [
						{
							path: bug().path,
							status: 'modified' as const,
							additions: 1,
							deletions: 1,
							binary: false,
							sizeBytes: original.length,
						},
					],
				},
			},
		},
	}
	return { repo, original, base, head, fake, dependencies, publisher, input }
}

/** A known existing bot-owned summary. */
function summary() {
	return {
		databaseId: 101,
		body: toMarkerComment('summary', SUMMARY_MARKER),
		author: { __typename: 'Bot', login: BOT_LOGIN },
		editor: null,
	}
}

/** A write refusal or unknown write result. */
function error(status?: number) {
	return new GitHubApiError({
		operation: 'write',
		reason: 'failure',
		...(status === undefined ? {} : { status }),
	})
}

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })(
	'PublishServiceLive',
	test => {
		test.effect(
			'first run creates a review and summary, second edits only the summary and increments runs',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(yield* publisher.publish(fixture.input)).toMatchObject({
						onLine: 1,
						repeated: 0,
						dismissed: 0,
						run: 1,
						verdict: 'needs fixes',
					})
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'review',
						'create',
					])
					const [review] = fixture.fake.writes
					expect(review).toMatchObject({
						method: 'review',
						pullNumber: 17,
						input: {
							commitId: fixture.head,
							body: `MNG Review: 1 new comment(s) on \`${fixture.head.slice(0, SHORT_SHA_LENGTH)}\`. The summary is in the conversation.`,
							comments: [{ path: bug().path, line: bug().line }],
						},
					})
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')?.runs
					).toBe(1)
					expect(yield* publisher.publish(fixture.input)).toMatchObject({
						onLine: 0,
						repeated: 1,
						run: 2,
					})
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'review',
						'create',
						'update',
					])
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
					).toMatchObject({ runs: 2, head: fixture.head, finished: true })
				})
		)
		for (const login of ['contributor', BOT_LOGIN])
			test.effect(
				`a thread edited by User ${login} does not suppress the finding`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const thread = reviewThread()
						fixture.fake.threads.push({
							...thread,
							comments: {
								...thread.comments,
								nodes: thread.comments.nodes.map(comment => ({
									...comment,
									editor: { __typename: 'User', login },
								})),
							},
						})
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(yield* publisher.publish(fixture.input)).toMatchObject({
							onLine: 1,
							repeated: 0,
						})
					})
			)
		for (const refusals of [0, 1, 2])
			test.effect(
				`422 review falls back through ${refusals} single-comment refusals`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.failures.review.push(error(422))
						fixture.fake.failures.comment.push(
							...Array.from({ length: refusals }, () => error(422))
						)
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(yield* publisher.publish(fixture.input)).toMatchObject({
							onLine: refusals === 0 ? 1 : 0,
							onFile: refusals === 1 ? 1 : 0,
							inSummary: refusals === 2 ? 1 : 0,
							unposted: 0,
						})
						const singles = fixture.fake.writes.filter(
							call => call.method === 'comment'
						)
						expect(singles.map(call => call.input.line)).toEqual(
							refusals === 0 ? [bug().line] : [bug().line, undefined]
						)
						expect(fixture.fake.writes.at(-1)?.method).toBe('create')
					})
			)
		for (const status of [500, 503, undefined])
			test.effect(
				`unknown review result ${status} leaves threads unposted and writes only the summary`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.failures.review.push(error(status))
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(yield* publisher.publish(fixture.input)).toMatchObject({
							unposted: 1,
							onLine: 0,
							onFile: 0,
						})
						expect(fixture.fake.writes.map(call => call.method)).toEqual([
							'review',
							'create',
						])
					})
			)
		test.effect('recreates a summary whose update returned 404', () =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.comments.push(summary())
				fixture.fake.failures.update.push(error(404))
				const publisher = yield* PublishService.pipe(
					Effect.provide(fixture.publisher)
				)
				yield* publisher.publish(fixture.input)
				expect(fixture.fake.writes.map(call => call.method)).toEqual([
					'review',
					'update',
					'create',
				])
				expect(fixture.fake.writes[1]).toMatchObject({
					method: 'update',
					id: 101,
				})
			})
		)
		test.effect(
			'status creates an unfinished summary and then updates it without another comment',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					const input = {
						pullNumber: 17,
						head: fixture.head,
						engineCommit: undefined,
						status: 'Reviewer offline',
					}
					expect(yield* publisher.publishStatus(input)).toBe(true)
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'create',
					])
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
					).toEqual({ v: SUMMARY_MARKER.v, runs: 0, finished: false })
					const originalBody = fixture.fake.comments[0]?.body
					expect(
						yield* publisher.publishStatus({
							...input,
							status: 'Another failure',
						})
					).toBe(false)
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'create',
						'update',
					])
					expect(fixture.fake.comments[0]?.body).toBe(originalBody)
				})
		)
		for (const scenario of [
			'untouched',
			'touched',
			'undone',
			'unknown',
		] as const)
			test.effect(`resolved thread with ${scenario} history`, () =>
				Effect.gen(function* () {
					const fixture = setup()
					const thread = reviewThread(undefined, { isResolved: true })
					fixture.fake.threads.push({
						...thread,
						comments: {
							...thread.comments,
							nodes: thread.comments.nodes.map(comment => ({
								...comment,
								originalCommit: {
									oid: scenario === 'unknown' ? '0'.repeat(40) : fixture.head,
								},
							})),
						},
					})
					if (scenario === 'touched' || scenario === 'undone') {
						fixture.repo.write(
							bug().path,
							fixture.original.replace('line 10\n', 'fixed 10\n')
						)
						fixture.repo.commit()
					}
					if (scenario === 'undone') {
						fixture.repo.write(
							bug().path,
							fixture.original.replace('line 10\n', 'changed 10\n')
						)
						fixture.repo.commit()
					}
					if (scenario === 'untouched') {
						fixture.repo.write(
							bug().path,
							fixture.original
								.replace('line 10\n', 'changed 10\n')
								.replace('line 35\n', 'changed 35\n')
						)
						fixture.repo.commit()
					}
					const head = fixture.repo.git('rev-parse', 'HEAD')
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(
						yield* publisher.publish({ ...fixture.input, head })
					).toMatchObject({
						onLine: scenario === 'untouched' ? 0 : 1,
						repeated: 0,
						dismissed: scenario === 'untouched' ? 1 : 0,
						openBugs: scenario === 'untouched' ? 0 : 1,
						verdict: scenario === 'untouched' ? 'ready' : 'needs fixes',
					})
				})
			)
		test.effect(
			'a resolved thread on this head is dismissed without checking git log',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const thread = reviewThread(undefined, { isResolved: true })
					fixture.fake.threads.push({
						...thread,
						comments: {
							...thread.comments,
							nodes: thread.comments.nodes.map(comment => ({
								...comment,
								originalCommit: { oid: fixture.head },
							})),
						},
					})
					const git = yield* GitService.pipe(
						Effect.provide(gitLayer(fixture.repo.root))
					)
					const execSpy = vi.spyOn(git, 'exec')
					const publisher = yield* PublishService.pipe(
						Effect.provide(
							PublishServiceLive.pipe(
								Layer.provide(
									Layer.merge(
										fixture.dependencies,
										Layer.succeed(GitService, git)
									)
								)
							)
						)
					)
					expect(yield* publisher.publish(fixture.input)).toMatchObject({
						dismissed: 1,
						repeated: 0,
						onLine: 0,
						onFile: 0,
						inSummary: 0,
						unposted: 0,
						openBugs: 0,
						verdict: 'ready',
					})
					expect(execSpy.mock.calls.some(([args]) => args[0] === 'log')).toBe(
						false
					)
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'create',
					])
					expect(fixture.fake.comments[0]?.body).toContain(
						'Found again under threads resolved without a code change, not blocking (1):'
					)
				})
		)
		for (const trailingNewline of [false, true])
			test.effect(
				`a resolved finding past EOF is dismissed when the last lines did not change, trailing newline=${trailingNewline}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const text = trailingNewline
							? fixture.original
							: fixture.original.trimEnd()
						fixture.repo.write(bug().path, text)
						const commit = fixture.repo.commit()
						const finding = bug({ line: 100 })
						const thread = reviewThread(
							{ finding, kind: 'bug' },
							{ isResolved: true }
						)
						fixture.fake.threads.push({
							...thread,
							comments: {
								...thread.comments,
								nodes: thread.comments.nodes.map(comment => ({
									...comment,
									originalCommit: { oid: commit },
								})),
							},
						})
						fixture.repo.write(
							bug().path,
							text.replace('line 10\n', 'changed again 10\n')
						)
						const head = fixture.repo.commit()
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(
							yield* publisher.publish({
								...fixture.input,
								head,
								report: { ...fixture.input.report, bugs: [finding] },
							})
						).toMatchObject({
							dismissed: 1,
							repeated: 0,
							onLine: 0,
							onFile: 0,
							inSummary: 0,
							unposted: 0,
							openBugs: 0,
							verdict: 'ready',
						})
						expect(fixture.fake.writes.map(call => call.method)).toEqual([
							'create',
						])
					})
			)
		test.effect('uses a real GitService with the temporary repository', () =>
			Effect.gen(function* () {
				const fixture = setup()
				const git = yield* GitService.pipe(
					Effect.provide(gitLayer(fixture.repo.root))
				)
				expect(yield* git.resolveCommit('HEAD')).toBe(fixture.head)
			})
		)
	}
)

layer(Layer.empty, { excludeTestServices: true })(
	'PublishServiceLive batching and status',
	test => {
		test.effect(
			'batches bugs, unverified findings and nits in one review and only bugs block',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const unverified = bug({
						line: 11,
						fingerprint: 'unverified',
						placement: 'summary',
						validation: {
							status: 'unverified',
							severity: 'high',
							reason: 'No dependency contract',
							premise: 'Dependency behavior',
							model: 'validator',
							evidence: [],
						},
					})
					const nit = bug({ line: 12, fingerprint: 'nit', kind: 'nit' })
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(
						yield* publisher.publish({
							...fixture.input,
							report: {
								...fixture.input.report,
								bugs: [bug(), unverified],
								nits: [nit],
							},
						})
					).toMatchObject({ onLine: 3, openBugs: 1, verdict: 'needs fixes' })
					const reviews = fixture.fake.writes.filter(
						call => call.method === 'review'
					)
					expect(reviews).toHaveLength(1)
					expect(
						reviews[0]?.input.comments.map(
							comment => parseFindingMarker(comment.body)?.kind
						)
					).toEqual(['bug', 'unverified', 'nit'])
				})
		)
		for (const status of [500, 503, undefined])
			test.effect(
				`review error ${status} records unposted threads without another thread write`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.failures.review.push(error(status))
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(yield* publisher.publish(fixture.input)).toMatchObject({
							unposted: 1,
							onLine: 0,
							onFile: 0,
							inSummary: 0,
						})
						expect(
							fixture.fake.writes
								.filter(
									call => call.method === 'review' || call.method === 'comment'
								)
								.map(call => call.method)
						).toEqual(['review'])
					})
			)
		test.effect(
			'uses the oldest eligible bot summary and ignores human-edited markers',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.comments.push(
						{
							...summary(),
							databaseId: 1,
							author: { __typename: 'User', login: BOT_LOGIN },
						},
						{
							...summary(),
							databaseId: 2,
							editor: { __typename: 'User', login: 'contributor' },
						},
						{
							...summary(),
							databaseId: 5,
							editor: { __typename: 'User', login: BOT_LOGIN },
						},
						{ ...summary(), databaseId: 3 },
						{ ...summary(), databaseId: 4 }
					)
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					yield* publisher.publish(fixture.input)
					expect(
						fixture.fake.writes
							.filter(call => call.method === 'update')
							.map(call => call.id)
					).toEqual([3])
				})
		)
		test.effect(
			'offline status preserves summary text and marks its existing runs and head unfinished',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const existing = {
						...summary(),
						body: `Verdict: ready\n${toMarkerComment('summary', { ...SUMMARY_MARKER, finished: true })}`,
					}
					fixture.fake.comments.push(existing)
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(
						yield* publisher.publishStatus({
							pullNumber: 17,
							head: fixture.head,
							engineCommit: 'engine',
							status: 'offline',
						})
					).toBe(false)
					const body = `Verdict: ready\n${toMarkerComment('summary', { ...SUMMARY_MARKER, finished: false })}`
					expect(fixture.fake.writes).toEqual([
						{ method: 'update', id: existing.databaseId, body },
					])
					expect(fixture.fake.comments).toEqual([{ ...existing, body }])
				})
		)
	}
)

layer(Layer.empty, { excludeTestServices: true })(
	'PublishService recheck summary',
	test => {
		test.effect(
			'an earlier bot closure permits a ready verdict while GitHub still shows the thread open',
			() =>
				Effect.gen(function* () {
					const recheckSpy = vi.fn(() =>
						Effect.succeed({ checked: 0, resolved: [], tokens: undefined })
					)
					const fixture = setup(recheckSpy)
					fixture.fake.threads.push(botClosedReviewThread())
					expect(
						yield* PublishService.use(publisher =>
							publisher.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [] },
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ openBugs: 0, verdict: 'ready', resolved: 0 })
					expect(recheckSpy.mock.calls).toHaveLength(1)
					expect(fixture.fake.threads[0]?.isResolved).toBe(false)
					expect(fixture.fake.writes.map(write => write.method)).toEqual([
						'create',
					])
				})
		)
		test.effect(
			'a sweep after an offline run uses the unfinished marker instead of an earlier successful verdict',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.comments.push({
						...summary(),
						body: `Verdict: ready\n${toMarkerComment('summary', { ...SUMMARY_MARKER, finished: true })}`,
					})
					fixture.fake.threads.push(botClosedReviewThread())
					expect(
						yield* PublishService.use(publisher =>
							publisher.publishStatus({
								pullNumber: 17,
								head: fixture.head,
								engineCommit: undefined,
								status: 'offline',
							})
						).pipe(Effect.provide(fixture.publisher))
					).toBe(false)
					const status = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([{ number: 17, head: { sha: fixture.head } }]),
						getStatus: () =>
							Effect.succeed({
								id: 1,
								...toCommitStatus('ready', 0, true),
								context: 'MNG Review',
								creator: null,
							}),
					})
					expect(
						yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fixture.fake.api, status.layer))
								)
							)
						)
					).toEqual({ checked: 1, updated: 1, failed: 0 })
					expect(status.statuses).toEqual([
						{ sha: fixture.head, ...toCommitStatus('incomplete', 0, false) },
					])
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
					).toEqual({ ...SUMMARY_MARKER, finished: false })
				})
		)
		test.effect(
			'an existing summary update failure is reported without creating another comment',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const existing = summary()
					fixture.fake.comments.push(existing)
					const failure = error(403)
					fixture.fake.failures.update.push(failure)
					expect(
						yield* PublishService.use(publisher =>
							publisher.publishStatus({
								pullNumber: 17,
								head: fixture.head,
								engineCommit: undefined,
								status: 'offline',
							})
						).pipe(Effect.provide(fixture.publisher), Effect.flip)
					).toEqual(failure)
					expect(fixture.fake.writes.map(write => write.method)).toEqual([
						'update',
					])
					expect(fixture.fake.comments).toEqual([existing])
				})
		)

		for (const ran of [true, false])
			test.effect(
				`resolved bugs no longer block, summary tokens use recheck=${ran}`,
				() =>
					Effect.gen(function* () {
						const tokens = {
							validator: {
								calls: 1,
								inputTokens: 2000,
								outputTokens: 0,
								cachedInputTokens: 0,
								reasoningTokens: 0,
								totalTokens: 2000,
							},
						}
						const fixture = setup(input =>
							Effect.succeed({
								checked: ran ? 1 : 0,
								resolved: ran
									? input.threads.map(found => ({
											thread: found,
											reason: 'The write is guarded.',
										}))
									: [],
								tokens: ran ? tokens : undefined,
							})
						)
						fixture.fake.threads.push(
							reviewThread({ finding: bug(), kind: 'bug' })
						)
						const published = yield* PublishService.use(publisher =>
							publisher.publish({
								...fixture.input,
								report: {
									...fixture.input.report,
									bugs: [],
									tokens: {
										reviewer: { ...tokens.validator, totalTokens: 1000 },
									},
								},
							})
						).pipe(Effect.provide(fixture.publisher))
						expect(published).toMatchObject({
							openBugs: ran ? 0 : 1,
							verdict: ran ? 'ready' : 'needs fixes',
							resolved: ran ? 1 : 0,
							rechecked: ran ? 1 : 0,
						})
						const summaryBody = fixture.fake.comments[0]?.body ?? ''
						if (ran) {
							expect(summaryBody).toContain(
								'Closed by this run, no longer found at the head (1)'
							)
							expect(summaryBody).toContain('The write is guarded.')
							expect(summaryBody).toContain('Tokens: validator 2k')
							expect(summaryBody).not.toContain('Tokens: reviewer')
						} else expect(summaryBody).toContain('Tokens: reviewer 1k')
					})
			)
	}
)

layer(Layer.empty, { excludeTestServices: true })(
	'PublishService last finished head',
	test => {
		for (const prior of ['absent', 'without-head', 'with-head'] as const)
			for (const outcome of [
				'finished',
				'endpoint',
				'budget',
				'failed',
				'incomplete',
			] as const)
				test.effect(
					`${outcome} run with prior ${prior} writes only the last finished head`,
					() =>
						Effect.gen(function* () {
							const recheckSpy = vi.fn<
								ThreadRecheckService['Service']['recheck']
							>(() =>
								Effect.succeed({ resolved: [], checked: 0, tokens: undefined })
							)
							const fixture = setup(recheckSpy)
							if (prior !== 'absent')
								fixture.fake.comments.push({
									...summary(),
									body: toMarkerComment('summary', {
										v: SUMMARY_MARKER.v,
										runs: 3,
										...(prior === 'with-head' ? { head: 'last-finished' } : {}),
									}),
								})
							const reviewed = {
								...fixture.input.report,
								bugs: [],
								agents: [
									agentReport(),
									{
										...agentReport(
											outcome === 'failed' || outcome === 'incomplete'
												? outcome
												: 'ok'
										),
										model: 'model-b',
									},
								],
								...(outcome === 'endpoint' ? { endpointError: 'offline' } : {}),
								...(outcome === 'budget'
									? {
											incomplete: {
												reason: 'budget spent' as const,
												unfinished: ['reviewer'],
											},
										}
									: {}),
							}
							const publisher = yield* PublishService.pipe(
								Effect.provide(fixture.publisher)
							)
							yield* publisher.publish({ ...fixture.input, report: reviewed })
							const expectedHead =
								outcome === 'finished'
									? fixture.head
									: prior === 'with-head'
										? 'last-finished'
										: undefined
							const marker = {
								v: SUMMARY_MARKER.v,
								runs: prior === 'absent' ? 1 : 4,
								finished: outcome === 'finished',
								...(expectedHead === undefined ? {} : { head: expectedHead }),
							}
							expect(
								parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
							).toEqual(marker)
							expect(
								yield* publisher.readPrior(fixture.input.pullNumber)
							).toEqual(marker)
							expect(recheckSpy).toHaveBeenCalledExactlyOnceWith(
								expect.objectContaining({
									pullNumber: fixture.input.pullNumber,
									rotation: prior === 'absent' ? 0 : 3,
								})
							)
						})
				)
		test.effect('offline summary has no reviewed head and zero runs', () =>
			Effect.gen(function* () {
				const fixture = setup()
				const publisher = yield* PublishService.pipe(
					Effect.provide(fixture.publisher)
				)
				yield* publisher.publishStatus({
					pullNumber: 17,
					head: fixture.head,
					engineCommit: 'engine',
					status: 'offline',
				})
				expect(
					parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
				).toEqual({ v: SUMMARY_MARKER.v, runs: 0, finished: false })
				expect(yield* publisher.readPrior(17)).toEqual({
					v: SUMMARY_MARKER.v,
					runs: 0,
					finished: false,
				})
			})
		)
	}
)
