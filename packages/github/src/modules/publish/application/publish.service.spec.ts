import { layer } from '@effect/vitest'
import { GitService } from '@mng-review/engine'
import { Effect, Layer, Redacted } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { provideOwnedIdentities } from '../../../platform/owned-identities.context'
import { agent } from '../../../shared/mocks/domain-test.helper'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { githubStatusFake } from '../../../shared/mocks/github-status-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	bug,
	botThread,
	botClosedReviewThread,
	agentReport,
	report,
	RULES,
	reviewThread,
	SUMMARY_MARKER,
	TOKEN_MODE_OWNED,
} from '../../../shared/mocks/publish-test.helper'
import {
	StatusReportService,
	StatusReportServiceLive,
} from '../../status/application/status-report.service'
import {
	StatusSweepService,
	StatusSweepServiceLive,
} from '../../status/application/status-sweep.service'
import {
	toCommitStatus,
	UNFINISHED_NOTE,
} from '../../status/domain/status.helper'
import {
	parseSummaryMarker,
	parseFindingMarker,
} from '../domain/publish-marker.parser'
import { SHORT_SHA_LENGTH } from '../domain/publish.constants'
import { PublishIncompleteError } from '../domain/publish.errors'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import { PublishService, PublishServiceLive } from './publish.service'
import {
	SummaryCommentService,
	SummaryCommentServiceLive,
} from './summary-comment.service'
import {
	ThreadResolutionService,
	ThreadResolutionServiceLive,
} from './thread-resolution.service'

/** Real git history with a finding on a changed head line and a recording API. */
function setup(
	apply?: ThreadResolutionService['Service']['apply'],
	identity = GITHUB_ACTIONS_IDENTITY
) {
	const repo = createRepo()
	const original = `${Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
	repo.write(bug().path, original)
	const base = repo.commit()
	repo.write(bug().path, original.replace('line 10\n', 'changed 10\n'))
	const head = repo.commit()
	const fake = githubApiFake(identity)
	fake.command.pullRequest = {
		...fake.command.pullRequest,
		head: { ...fake.command.pullRequest.head, sha: head },
	}
	const dependencies = Layer.mergeAll(
		fake.api,
		apply
			? Layer.succeed(ThreadResolutionService, { apply })
			: ThreadResolutionServiceLive.pipe(Layer.provide(fake.api)),
		Layer.succeed(GitHubConfig, {
			serverUrl: 'https://github.com',
			apiUrl: 'https://api.github.com',
			graphqlUrl: 'https://api.github.com/graphql',
			owner: 'example',
			name: 'project',
			token: Redacted.make('fixture'),
			identity,
		})
	)
	const publisher = PublishServiceLive.pipe(
		Layer.provideMerge(SummaryCommentServiceLive),
		Layer.provide(Layer.merge(dependencies, gitLayer(repo.root)))
	)
	const input = {
		pullNumber: 17,
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
		id: 'summary-node',
		databaseId: 101,
		isMinimized: false,
		body: toMarkerComment('summary', SUMMARY_MARKER),
		author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
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

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
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
		test.effect(
			'a summary failure after posting threads preserves the API error in PublishIncompleteError',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const existing = summary()
					const failure = error(403)
					fixture.fake.comments.push(existing)
					fixture.fake.failures.update.push(failure)
					const failed = yield* PublishService.use(service =>
						service.publish(fixture.input)
					).pipe(Effect.provide(fixture.publisher), Effect.flip)
					expect(failed).toBeInstanceOf(PublishIncompleteError)
					expect(failed).toEqual(new PublishIncompleteError({ error: failure }))
					expect(failed.message).toBe(failure.message)
					expect(fixture.fake.writes.map(write => write.method)).toEqual([
						'review',
						'update',
					])
					expect(fixture.fake.threads).toHaveLength(1)
					expect(fixture.fake.comments).toEqual([existing])
				})
		)
		test.effect(
			'a thread read failure before any write keeps the API error',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const failure = new GitHubApiError({
						operation: 'listReviewThreads',
						reason: 'threads unavailable',
						status: 503,
					})
					fixture.fake.failures.listThreads.push(failure)
					expect(
						yield* PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher), Effect.flip)
					).toBe(failure)
					expect(fixture.fake.threadReads).toEqual([fixture.input.pullNumber])
					expect(fixture.fake.writes).toEqual([])
					expect(fixture.fake.threads).toEqual([])
				})
		)
		for (const login of ['contributor', GITHUB_ACTIONS_IDENTITY.login])
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
						const marker = parseSummaryMarker(
							fixture.fake.comments[0]?.body ?? ''
						)
						expect(marker).toMatchObject({ head: fixture.head, finished: true })
						expect(marker?.unthreadedBugs).toBe(refusals === 2 ? 1 : undefined)
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
						expect(
							parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
						).toMatchObject({
							head: fixture.head,
							finished: true,
							unthreadedBugs: 1,
						})
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
					const publisher = yield* SummaryCommentService.pipe(
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
								Layer.provide(SummaryCommentServiceLive),
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

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishServiceLive batching and status',
	test => {
		for (const source of ['metadata', 'outside-diff'] as const)
			test.effect(
				`a published ${source} bug still blocks a sweep without any thread`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const finding = bug({
							agents: [source],
							path: source === 'outside-diff' ? 'outside.ts' : bug().path,
						})
						const published = yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules: {
									...RULES,
									agents: [
										agent(source, {
											input: source === 'metadata' ? 'metadata' : 'incremental',
										}),
									],
								},
								report: { ...fixture.input.report, bugs: [finding] },
							})
						).pipe(Effect.provide(fixture.publisher))
						expect(published).toMatchObject({
							inSummary: 1,
							openBugs: 1,
							verdict: 'needs fixes',
						})
						expect(
							parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
						).toMatchObject({
							head: fixture.head,
							finished: true,
							unthreadedBugs: 1,
						})
						expect(fixture.fake.threads).toEqual([])
						const status = toCommitStatus(
							published.verdict,
							published.openBugs,
							true
						)
						expect(status.state).toBe('failure')
						const fake = githubStatusFake({
							listOpenPullRequests: () =>
								Effect.succeed([
									{
										number: fixture.input.pullNumber,
										head: { sha: fixture.head },
									},
								]),
							getStatus: () =>
								Effect.succeed({
									id: 1,
									...status,
									context: 'MNG Review',
									creator: null,
								}),
						})
						expect(
							yield* StatusSweepService.use(service => service.sweep()).pipe(
								Effect.provide(
									StatusSweepServiceLive.pipe(
										Layer.provide(Layer.merge(fake.layer, fixture.fake.api))
									)
								)
							)
						).toEqual({ checked: 1, updated: 0, failed: 0 })
						expect(fake.statuses).toEqual([])
					})
			)

		test.effect(
			'publishes a metadata summary nit without a location or blocking bug count',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const finding = bug({
						kind: 'nit',
						placement: 'summary',
						agents: ['metadata'],
						evidence: [],
					})
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules: {
									...RULES,
									agents: [agent('metadata', { input: 'metadata' })],
								},
								report: { ...fixture.input.report, bugs: [], nits: [finding] },
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ inSummary: 1, openBugs: 0, verdict: 'ready' })
					const body = fixture.fake.comments[0]?.body ?? ''
					expect(body).toContain('About the pull request (1):')
					expect(body).not.toContain('Nits not posted inline')
					expect(body).not.toContain(`${finding.path}:${finding.line}`)
					expect(parseSummaryMarker(body)).toEqual({
						v: SUMMARY_MARKER.v,
						runs: 1,
						head: fixture.head,
						finished: true,
					})
					expect(fixture.fake.threads).toEqual([])
				})
		)
		for (const kind of ['bug', 'unverified', 'nit'] as const)
			test.effect(
				`keeps a metadata ${kind} in the summary with its count and verdict`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const finding = bug({
							agents: ['metadata'],
							kind: kind === 'nit' ? 'nit' : 'bug',
							placement: kind === 'unverified' ? 'summary' : 'inline',
							...(kind === 'unverified'
								? ({
										validation: {
											status: 'unverified',
											severity: 'high',
											premise: 'Pull request scope',
											reason: 'Missing description',
											evidence: [],
											model: 'validator',
										},
									} as const)
								: {}),
						})
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(
							yield* publisher.publish({
								...fixture.input,
								rules: {
									...RULES,
									agents: [agent('metadata', { input: 'metadata' })],
								},
								report: {
									...fixture.input.report,
									bugs: kind === 'nit' ? [] : [finding],
									nits: kind === 'nit' ? [finding] : [],
								},
							})
						).toMatchObject({
							onLine: 0,
							onFile: 0,
							inSummary: 1,
							unposted: 0,
							openBugs: kind === 'bug' ? 1 : 0,
							verdict: kind === 'bug' ? 'needs fixes' : 'ready',
						})
						expect(fixture.fake.writes.map(call => call.method)).toEqual([
							'create',
						])
						expect(fixture.fake.threads).toEqual([])
						expect(fixture.fake.comments[0]?.body).toContain(
							'About the pull request (1):'
						)
						const marker = parseSummaryMarker(
							fixture.fake.comments[0]?.body ?? ''
						)
						expect(marker).toMatchObject({ head: fixture.head, finished: true })
						expect(marker?.unthreadedBugs).toBe(kind === 'bug' ? 1 : undefined)
					})
			)
		test.effect(
			'counts metadata and outside-diff findings together while a diff finding at the same location stays inline',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const metadata = bug({
						agents: ['metadata'],
						fingerprint: 'metadata',
					})
					const diff = bug({ agents: ['diff'], fingerprint: 'diff' })
					const outside = bug({ path: 'outside.ts', fingerprint: 'outside' })
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(
						yield* publisher.publish({
							...fixture.input,
							rules: {
								...RULES,
								agents: [
									agent('metadata', { input: 'metadata' }),
									agent('diff', { input: 'incremental' }),
								],
							},
							report: {
								...fixture.input.report,
								bugs: [metadata, diff, outside],
							},
						})
					).toMatchObject({
						onLine: 1,
						onFile: 0,
						inSummary: 2,
						unposted: 0,
						openBugs: 3,
						verdict: 'needs fixes',
					})
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'review',
						'create',
					])
					const review = fixture.fake.writes.find(
						call => call.method === 'review'
					)
					expect(review?.input.comments).toHaveLength(1)
					expect(review?.input.comments[0]).toMatchObject({
						path: diff.path,
						line: diff.line,
					})
					expect(
						parseFindingMarker(review?.input.comments[0]?.body ?? '')
							?.fingerprint
					).toBe(diff.fingerprint)
					expect(fixture.fake.threads).toHaveLength(1)
					expect(fixture.fake.comments[0]?.body).toContain(
						'About the pull request (1):'
					)
					expect(fixture.fake.comments[0]?.body).toContain(
						'Not in the diff (1):'
					)
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
					).toMatchObject({
						head: fixture.head,
						finished: true,
						unthreadedBugs: 2,
					})
				})
		)
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
							author: {
								__typename: 'User',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						},
						{
							...summary(),
							databaseId: 2,
							editor: { __typename: 'User', login: 'contributor' },
						},
						{
							...summary(),
							databaseId: 5,
							editor: {
								__typename: 'User',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
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
					const publisher = yield* SummaryCommentService.pipe(
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

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService recheck summary',
	test => {
		test.effect(
			'an earlier bot closure permits a ready verdict while GitHub still shows the thread open',
			() =>
				Effect.gen(function* () {
					const applySpy = vi.fn(() => Effect.succeed([]))
					const fixture = setup(applySpy)
					fixture.fake.threads.push(botClosedReviewThread())
					expect(
						yield* PublishService.use(publisher =>
							publisher.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [] },
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ openBugs: 0, verdict: 'ready', resolved: 0 })
					expect(applySpy).not.toHaveBeenCalled()
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
						yield* SummaryCommentService.use(publisher =>
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
						yield* SummaryCommentService.use(publisher =>
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
						const fixture = setup()
						fixture.fake.threads.push(
							reviewThread({ finding: bug(), kind: 'bug' })
						)
						const published = yield* PublishService.use(publisher =>
							publisher.publish({
								...fixture.input,
								...(ran
									? {
											recheck: {
												checked: 1,
												proposals: [
													{
														threadId: 'thread',
														fingerprint: bug().fingerprint,
														reason: 'The write is guarded.',
													},
												],
												tokens,
											},
										}
									: {}),
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

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
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
							const fixture = setup()
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
							const summaries = yield* SummaryCommentService.pipe(
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
								yield* summaries.readPrior(fixture.input.pullNumber)
							).toEqual(marker)
						})
				)
		test.effect('offline summary has no reviewed head and zero runs', () =>
			Effect.gen(function* () {
				const fixture = setup()
				const publisher = yield* SummaryCommentService.pipe(
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

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService outcome proposals',
	test => {
		test.effect(
			'an applied proposal is resolved in the plan, verdict and summary in the same run',
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
								originalCommit: { oid: fixture.head },
							})),
						},
					})
					fixture.repo.write(
						bug().path,
						fixture.original
							.replace('line 10\n', 'changed 10\n')
							.replace('line 35\n', 'changed 35\n')
					)
					const head = fixture.repo.commit()
					const published = yield* PublishService.use(publisher =>
						publisher.publish({
							...fixture.input,
							head,
							recheck: {
								checked: 1,
								proposals: [
									{
										threadId: thread.id,
										fingerprint: bug().fingerprint,
										reason: 'The guard covers this write.',
									},
								],
								tokens: {},
							},
						})
					).pipe(Effect.provide(fixture.publisher))
					expect(published).toMatchObject({
						dismissed: 1,
						repeated: 0,
						onLine: 0,
						openBugs: 0,
						resolved: 1,
						rechecked: 1,
						verdict: 'ready',
					})
					expect(fixture.fake.writes.map(write => write.method)).toEqual([
						'reply',
						'resolve',
						'create',
					])
					const body = fixture.fake.comments[0]?.body ?? ''
					expect(body).toContain(
						'Closed by this run, no longer found at the head (1)'
					)
					expect(body).toContain(
						'Found again under threads resolved without a code change, not blocking (1)'
					)
					expect(body).toContain('**Verdict: ready**')
					expect(body).toContain('0 open bug thread(s)')
				})
		)
		for (const ownership of ['user', 'other-bot', 'edited'] as const)
			test.effect(
				`a proposal for a ${ownership} thread writes no reply or resolution`,
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
									...(ownership === 'edited'
										? { editor: { __typename: 'User', login: 'contributor' } }
										: {
												author: {
													__typename: ownership === 'user' ? 'User' : 'Bot',
													login:
														ownership === 'user'
															? GITHUB_ACTIONS_IDENTITY.login
															: 'another-bot',
												},
											}),
								})),
							},
						})
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(
							yield* publisher.readThreads(fixture.input.pullNumber)
						).toEqual([])
						expect(
							yield* publisher.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [] },
								recheck: {
									checked: 1,
									proposals: [
										{
											threadId: thread.id,
											fingerprint: bug().fingerprint,
											reason: 'Do not apply.',
										},
									],
									tokens: {},
								},
							})
						).toMatchObject({ resolved: 0 })
						expect(fixture.fake.writes.map(write => write.method)).toEqual([
							'create',
						])
					})
			)
		test.effect(
			'readThreads exposes only fresh bot-owned threads and preserves their fingerprint',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push(reviewThread())
					expect(
						yield* PublishService.use(publisher =>
							publisher.readThreads(17)
						).pipe(Effect.provide(fixture.publisher))
					).toEqual([
						botThread({
							latestCommentId: 1,
							latestAuthor: { type: 'Bot', login: 'github-actions' },
						}),
					])
					expect(fixture.fake.threadReads).toEqual([17])
					expect(fixture.fake.writes).toEqual([])
				})
		)
	}
)

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService app mode',
	test => {
		for (const trust of [true, false])
			test.effect(
				`an earlier open job-token thread is repeated with previous trust=${trust}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup(undefined, APP_IDENTITY)
						fixture.fake.threads.push(reviewThread())
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(
							yield* publisher
								.publish(fixture.input)
								.pipe(
									provideOwnedIdentities(
										APP_IDENTITY,
										trust ? RULES.config.identity.previous : []
									)
								)
						).toMatchObject({ repeated: trust ? 1 : 0, onLine: trust ? 0 : 1 })
						expect(
							fixture.fake.writes.filter(
								write => write.method === 'review' || write.method === 'comment'
							)
						).toHaveLength(trust ? 0 : 1)
					})
			)
		test.effect(
			'an earlier resolved job-token thread dismisses the finding when its code is unchanged',
			() =>
				Effect.gen(function* () {
					const fixture = setup(undefined, APP_IDENTITY)
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
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(yield* publisher.publish(fixture.input)).toMatchObject({
						dismissed: 1,
						repeated: 0,
						onLine: 0,
					})
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'review' || write.method === 'comment'
						)
					).toEqual([])
				})
		)
	}
)

/** Runs the supplied resolution fake between the first thread read and the summary write. */
function setupOverlap(apply: ThreadResolutionService['Service']['apply']) {
	const fixture = setup(apply)
	return {
		...fixture,
		input: {
			...fixture.input,
			recheck: {
				checked: 0,
				proposals: [],
				tokens: fixture.input.report.tokens,
			},
		},
	}
}
layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService command completion',
	test => {
		for (const previous of [
			'none',
			'legacy',
			'unfinished',
			'other-head',
			'same-head',
		] as const)
			test.effect(
				`single-agent command completion with ${previous} full review`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						if (previous !== 'none')
							fixture.fake.comments.push({
								...summary(),
								body: toMarkerComment('summary', {
									...SUMMARY_MARKER,
									head: previous === 'other-head' ? 'old-head' : fixture.head,
									manualRuns: 2,
									...(previous === 'legacy'
										? {}
										: { finished: previous !== 'unfinished' }),
								}),
							})
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(
							yield* publisher.publish({
								...fixture.input,
								command: { agentOnly: true },
								report: { ...fixture.input.report, bugs: [] },
							})
						).toMatchObject({
							finished: previous === 'same-head',
							verdict: previous === 'same-head' ? 'ready' : 'incomplete',
							openBugs: 0,
						})
						expect(
							parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
								?.manualRuns
						).toBe(previous === 'none' ? undefined : 2)
					})
			)
		for (const agentOnly of [false, true])
			test.effect(
				`publishing a command with agentOnly=${agentOnly} retains the reserved manual run count across publishes`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.comments.push({
							...summary(),
							body: toMarkerComment('summary', {
								...SUMMARY_MARKER,
								head: fixture.head,
								finished: true,
								manualRuns: 3,
							}),
						})
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						for (const runs of [2, 3]) {
							yield* publisher.publish({
								...fixture.input,
								command: { agentOnly },
							})
							expect(
								parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
							).toMatchObject({ runs, manualRuns: 3 })
						}
					})
			)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService summary changed during review',
	test => {
		for (const previous of ['none', 'unfinished', 'finished'] as const)
			for (const freshState of [
				'same-head',
				'other-head',
				'unfinished',
			] as const)
				for (const hasBug of [false, true])
					test.effect(
						`agent command uses fresh ${freshState} review after ${previous}, bug=${hasBug}`,
						() =>
							Effect.gen(function* () {
								const applySpy =
									vi.fn<ThreadResolutionService['Service']['apply']>()
								const fixture = setupOverlap(applySpy)
								if (previous !== 'none')
									fixture.fake.comments.push({
										...summary(),
										body: toMarkerComment('summary', {
											...SUMMARY_MARKER,
											head: fixture.head,
											runs: 2,
											manualRuns: 1,
											finished: previous === 'finished',
										}),
									})
								const fresh = {
									...SUMMARY_MARKER,
									runs: 7,
									manualRuns: 3,
									head:
										freshState === 'other-head'
											? 'new-full-review-head'
											: fixture.head,
									finished: freshState !== 'unfinished',
								}
								applySpy.mockImplementation(() =>
									Effect.sync(() => {
										expect(fixture.fake.reads).toEqual([])
										fixture.fake.comments.splice(
											0,
											fixture.fake.comments.length,
											{
												...summary(),
												databaseId: 202,
												body: toMarkerComment('summary', fresh),
											}
										)
										return []
									})
								)
								const finished = freshState === 'same-head'
								const verdict = hasBug
									? 'needs fixes'
									: finished
										? 'ready'
										: 'incomplete'
								expect(
									yield* PublishService.use(publisher =>
										publisher.publish({
											...fixture.input,
											command: { agentOnly: true },
											report: {
												...fixture.input.report,
												bugs: hasBug ? [bug()] : [],
											},
										})
									).pipe(Effect.provide(fixture.publisher))
								).toMatchObject({
									run: 8,
									finished,
									verdict,
									openBugs: hasBug ? 1 : 0,
								})
								const body = fixture.fake.comments[0]?.body ?? ''
								expect(parseSummaryMarker(body)).toEqual({ ...fresh, runs: 8 })
								expect(body).toContain(`**Verdict: ${verdict}**`)
								expect(body).toContain('run 8 of')
								expect(
									fixture.fake.writes.filter(write => write.method === 'update')
								).toEqual([{ method: 'update', id: 202, body }])
								expect(fixture.fake.reads).toEqual(['getPullRequest:17'])
							})
					)
		for (const finished of [false, true])
			test.effect(
				`push uses its own finished=${finished} and the fresh run count without reading the pull request`,
				() =>
					Effect.gen(function* () {
						const applySpy =
							vi.fn<ThreadResolutionService['Service']['apply']>()
						const fixture = setupOverlap(applySpy)
						fixture.fake.comments.push(summary())
						fixture.fake.command.pullRequest = {
							...fixture.fake.command.pullRequest,
							head: {
								...fixture.fake.command.pullRequest.head,
								sha: 'moved-head',
							},
						}
						const fresh = {
							...SUMMARY_MARKER,
							head: 'new-full-review-head',
							runs: 7,
							manualRuns: 3,
							finished: !finished,
						}
						applySpy.mockImplementation(() =>
							Effect.sync(() => {
								fixture.fake.comments.splice(0, 1, {
									...summary(),
									body: `**Verdict: needs fixes**\nOther run details.\n\n${toMarkerComment('summary', fresh)}`,
								})
								return []
							})
						)
						const verdict = finished ? 'ready' : 'incomplete'
						expect(
							yield* PublishService.use(publisher =>
								publisher.publish({
									...fixture.input,
									report: {
										...fixture.input.report,
										bugs: [],
										...(finished ? {} : { endpointError: 'offline' }),
									},
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({ run: 8, finished, verdict })
						const body = fixture.fake.comments[0]?.body ?? ''
						expect(parseSummaryMarker(body)).toEqual({
							...fresh,
							runs: 8,
							head: finished ? fixture.head : fresh.head,
							finished,
						})
						expect(body).toContain(`**Verdict: ${verdict}**`)
						expect(body).not.toContain('Other run details.')
						expect(fixture.fake.reads).toEqual([])
					})
			)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService command head check',
	test => {
		test.effect(
			'a full command on the unchanged head records its head and completion',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.comments.push({
						...summary(),
						body: `**Verdict: needs fixes**\nStale review details.\n\n${toMarkerComment(
							'summary',
							{
								...SUMMARY_MARKER,
								runs: 4,
								manualRuns: 2,
								finished: false,
							}
						)}`,
					})
					expect(
						yield* PublishService.use(publisher =>
							publisher.publish({
								...fixture.input,
								command: { agentOnly: false },
								report: { ...fixture.input.report, bugs: [] },
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ run: 5, finished: true, verdict: 'ready' })
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
					).toEqual({
						...SUMMARY_MARKER,
						runs: 5,
						manualRuns: 2,
						head: fixture.head,
						finished: true,
					})
					expect(fixture.fake.comments[0]?.body).toContain('**Verdict: ready**')
					expect(fixture.fake.comments[0]?.body).not.toContain(
						'Stale review details.'
					)
					expect(fixture.fake.reads).toEqual(['getPullRequest:17'])
				})
		)
		for (const agentOnly of [false, true])
			for (const previous of [
				'none',
				'unfinished',
				'other-head',
				'same-head',
			] as const)
				test.effect(
					`moved command head preserves ${previous} full review with agentOnly=${agentOnly}`,
					() =>
						Effect.gen(function* () {
							const fixture = setup()
							const prior = {
								...SUMMARY_MARKER,
								head:
									previous === 'same-head'
										? fixture.head
										: 'new-full-review-head',
								runs: 4,
								manualRuns: 2,
								finished: previous !== 'unfinished',
							}
							const visible =
								'**Verdict: needs fixes**\nCurrent review on the newer head.\n\n'
							if (previous !== 'none')
								fixture.fake.comments.push({
									...summary(),
									body: visible + toMarkerComment('summary', prior),
								})
							fixture.fake.command.pullRequest = {
								...fixture.fake.command.pullRequest,
								head: {
									...fixture.fake.command.pullRequest.head,
									sha: 'moved-head',
								},
							}
							const finished = previous === 'same-head'
							const verdict = finished ? 'ready' : 'incomplete'
							expect(
								yield* PublishService.use(publisher =>
									publisher.publish({
										...fixture.input,
										command: { agentOnly },
										report: { ...fixture.input.report, bugs: [] },
									})
								).pipe(Effect.provide(fixture.publisher))
							).toMatchObject({
								run: previous === 'none' ? 1 : 5,
								finished,
								verdict,
							})
							const body = fixture.fake.comments[0]?.body ?? ''
							expect(parseSummaryMarker(body)).toEqual(
								previous === 'none'
									? { v: SUMMARY_MARKER.v, runs: 1, finished: false }
									: { ...prior, runs: 5 }
							)
							if (previous === 'none')
								expect(body).toContain(`**Verdict: ${verdict}**`)
							else
								expect(
									body.replace(/<!-- mng-review:summary .* -->$/u, '')
								).toBe(visible)
							expect(fixture.fake.reads).toEqual(['getPullRequest:17'])
						})
				)
		for (const headState of ['moved', 'unreadable'] as const)
			for (const agentOnly of [false, true])
				test.effect(
					`preserves the freshly read summary when the head is ${headState}, agentOnly=${agentOnly}`,
					() =>
						Effect.gen(function* () {
							const applySpy =
								vi.fn<ThreadResolutionService['Service']['apply']>()
							const fixture = setupOverlap(applySpy)
							fixture.fake.comments.push({
								...summary(),
								body: `Stale visible review\n\n${toMarkerComment('summary', SUMMARY_MARKER)}`,
							})
							const fresh = {
								...SUMMARY_MARKER,
								head: 'current-head',
								finished: true,
								runs: 7,
								manualRuns: 3,
							}
							const visible =
								'**Verdict: ready**\nCurrent review details and current-head.\n\n'
							applySpy.mockImplementation(() =>
								Effect.sync(() => {
									fixture.fake.comments.splice(0, 1, {
										...summary(),
										databaseId: 202,
										body: visible + toMarkerComment('summary', fresh),
									})
									return []
								})
							)
							if (headState === 'unreadable')
								fixture.fake.failures.getPullRequest.push(error(503))
							else
								fixture.fake.command.pullRequest = {
									...fixture.fake.command.pullRequest,
									head: {
										...fixture.fake.command.pullRequest.head,
										sha: 'moved-head',
									},
								}
							expect(
								yield* PublishService.use(publisher =>
									publisher.publish({
										...fixture.input,
										command: { agentOnly },
									})
								).pipe(Effect.provide(fixture.publisher))
							).toMatchObject({
								run: 8,
								openBugs: 1,
								verdict: 'needs fixes',
								finished: false,
							})
							const body = fixture.fake.comments[0]?.body ?? ''
							expect(parseSummaryMarker(body)).toEqual({ ...fresh, runs: 8 })
							expect(body.replace(/<!-- mng-review:summary .* -->$/u, '')).toBe(
								visible
							)
							expect(
								fixture.fake.writes.filter(write => write.method === 'update')
							).toEqual([{ method: 'update', id: 202, body }])
						})
				)
		for (const agentOnly of [false, true])
			for (const status of [404, 503])
				for (const previous of ['none', 'unfinished', 'finished'] as const)
					test.effect(
						`getPullRequest ${status} counts as moved with agentOnly=${agentOnly}, previous=${previous}`,
						() =>
							Effect.gen(function* () {
								const fixture = setup()
								const marker = {
									...SUMMARY_MARKER,
									head: 'previous-head',
									finished: previous === 'finished',
									runs: 4,
									manualRuns: 2,
								}
								const visible =
									'**Verdict: needs fixes**\nPrevious review details.\n\n'
								if (previous !== 'none')
									fixture.fake.comments.push({
										...summary(),
										body: visible + toMarkerComment('summary', marker),
									})
								fixture.fake.failures.getPullRequest.push(
									new GitHubApiError({
										operation: 'getPullRequest',
										status,
										reason: 'unavailable',
									})
								)
								expect(
									yield* PublishService.use(publisher =>
										publisher.publish({
											...fixture.input,
											command: { agentOnly },
											report: { ...fixture.input.report, bugs: [] },
										})
									).pipe(Effect.provide(fixture.publisher))
								).toMatchObject({
									run: previous === 'none' ? 1 : 5,
									finished: false,
									verdict: 'incomplete',
								})
								const body = fixture.fake.comments[0]?.body ?? ''
								if (previous === 'none') {
									expect(parseSummaryMarker(body)).toEqual({
										v: SUMMARY_MARKER.v,
										runs: 1,
										finished: false,
									})
									expect(body).toContain('**Verdict: incomplete**')
								} else {
									expect(parseSummaryMarker(body)).toEqual({
										...marker,
										runs: 5,
									})
									expect(
										body.replace(/<!-- mng-review:summary .* -->$/u, '')
									).toBe(visible)
								}
								expect(fixture.fake.writes.map(write => write.method)).toEqual([
									previous === 'none' ? 'create' : 'update',
								])
								expect(fixture.fake.reads).toEqual(['getPullRequest:17'])
							})
					)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService unthreaded bugs',
	test => {
		for (const place of ['summary', 'unposted'] as const)
			test.effect(
				`a single-agent ${place} bug after a clean full review stays failure through the sweep`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						const clean = {
							...fixture.input,
							report: { ...fixture.input.report, bugs: [] },
						}
						expect(yield* publisher.publish(clean)).toMatchObject({
							verdict: 'ready',
							openBugs: 0,
							finished: true,
						})
						expect(
							parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
						).toEqual({
							v: SUMMARY_MARKER.v,
							runs: 1,
							head: fixture.head,
							finished: true,
						})
						if (place === 'unposted')
							fixture.fake.failures.review.push(error(503))
						const published = yield* publisher.publish({
							...fixture.input,
							command: { agentOnly: true },
							report: {
								...fixture.input.report,
								bugs: [
									bug({
										path: place === 'summary' ? 'outside-diff.ts' : bug().path,
									}),
								],
							},
						})
						expect(published).toMatchObject({
							verdict: 'needs fixes',
							openBugs: 1,
							finished: true,
							inSummary: place === 'summary' ? 1 : 0,
							unposted: place === 'unposted' ? 1 : 0,
						})
						expect(
							parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
						).toEqual({
							v: SUMMARY_MARKER.v,
							runs: 2,
							head: fixture.head,
							finished: true,
							unthreadedBugs: 1,
						})
						expect(fixture.fake.threads).toEqual([])
						const status = toCommitStatus(
							published.verdict,
							published.openBugs,
							published.finished
						)
						expect(status.state).toBe('failure')
						const statuses = githubStatusFake({
							listOpenPullRequests: () =>
								Effect.succeed([
									{
										number: fixture.input.pullNumber,
										head: { sha: fixture.head },
									},
								]),
							getStatus: () =>
								Effect.succeed({
									id: 1,
									...status,
									context: 'MNG Review',
									creator: null,
								}),
						})
						expect(
							yield* StatusSweepService.use(service => service.sweep()).pipe(
								Effect.provide(
									StatusSweepServiceLive.pipe(
										Layer.provide(Layer.merge(statuses.layer, fixture.fake.api))
									)
								)
							)
						).toEqual({ checked: 1, updated: 0, failed: 0 })
						expect(statuses.statuses).toEqual([])
						expect(statuses.statuses.at(-1)?.state ?? status.state).toBe(
							'failure'
						)
						expect(yield* publisher.publish(clean)).toMatchObject({
							verdict: 'ready',
							openBugs: 0,
							finished: true,
						})
						expect(
							parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
						).toEqual({
							v: SUMMARY_MARKER.v,
							runs: 3,
							head: fixture.head,
							finished: true,
						})
					})
			)
		for (const stopped of ['endpoint', 'budget', 'failed'] as const)
			for (const place of ['none', 'summary', 'unposted'] as const)
				test.effect(
					`an unfinished ${stopped} full review carries two bugs and adds its own ${place} bug once`,
					() =>
						Effect.gen(function* () {
							const fixture = setup()
							const publisher = yield* PublishService.pipe(
								Effect.provide(fixture.publisher)
							)
							expect(
								yield* publisher.publish({
									...fixture.input,
									report: {
										...fixture.input.report,
										bugs: [
											bug({ path: 'outside-a.ts', fingerprint: 'prior-a' }),
											bug({ path: 'outside-b.ts', fingerprint: 'prior-b' }),
										],
									},
								})
							).toMatchObject({
								verdict: 'needs fixes',
								openBugs: 2,
								finished: true,
								inSummary: 2,
							})
							expect(
								parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
							).toEqual({
								v: SUMMARY_MARKER.v,
								runs: 1,
								head: fixture.head,
								finished: true,
								unthreadedBugs: 2,
							})
							if (place === 'unposted')
								fixture.fake.failures.review.push(error(503))
							const reviewed = {
								...fixture.input.report,
								bugs:
									place === 'none'
										? []
										: [
												bug({
													path:
														place === 'summary' ? 'outside-new.ts' : bug().path,
													fingerprint: 'new-bug',
												}),
											],
								...(stopped === 'endpoint' ? { endpointError: 'offline' } : {}),
								...(stopped === 'budget'
									? {
											incomplete: {
												reason: 'budget spent',
												unfinished: ['reviewer'],
											},
										}
									: {}),
								agents: [agentReport(stopped === 'failed' ? 'failed' : 'ok')],
							}
							const published = yield* publisher.publish({
								...fixture.input,
								report: reviewed,
							})
							const openBugs = place === 'none' ? 2 : 3
							expect(published).toMatchObject({
								verdict: 'needs fixes',
								openBugs,
								finished: false,
								inSummary: place === 'summary' ? 1 : 0,
								unposted: place === 'unposted' ? 1 : 0,
							})
							expect(
								parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
							).toEqual({
								v: SUMMARY_MARKER.v,
								runs: 2,
								head: fixture.head,
								finished: false,
								unthreadedBugs: openBugs,
							})
							expect(fixture.fake.comments[0]?.body).toContain(
								'2 bug(s) without a thread from earlier runs on this head still count until a full review checks them again.'
							)
							expect(fixture.fake.threads).toEqual([])
							const status = toCommitStatus(
								published.verdict,
								published.openBugs,
								published.finished
							)
							expect(status).toEqual({
								state: 'failure',
								description: `${openBugs} open bug thread(s); needs fixes; ${UNFINISHED_NOTE}`,
							})
							const statuses = githubStatusFake()
							expect(
								yield* StatusReportService.use(service =>
									service.report({
										head: fixture.head,
										report: reviewed,
										verdict: published.verdict,
										openBugs: published.openBugs,
										finished: published.finished,
									})
								).pipe(
									Effect.provide(
										StatusReportServiceLive.pipe(Layer.provide(statuses.layer))
									)
								)
							).toEqual({ checks: 1, status: true })
							expect(statuses.statuses).toEqual([
								{ sha: fixture.head, ...status },
							])
							expect(
								yield* publisher.publish({
									...fixture.input,
									report: { ...fixture.input.report, bugs: [] },
								})
							).toMatchObject({
								verdict: 'ready',
								openBugs: 0,
								finished: true,
							})
							expect(
								parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
							).toEqual({
								v: SUMMARY_MARKER.v,
								runs: 3,
								head: fixture.head,
								finished: true,
							})
							expect(fixture.fake.comments[0]?.body).not.toContain(
								'from earlier runs on this head still count'
							)
						})
				)
		for (const sameHead of [false, true])
			test.effect(
				`a moved full run with an unthreaded bug adds it only on the marker head, same=${sameHead}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const prior = {
							...SUMMARY_MARKER,
							head: sameHead ? fixture.head : 'other-head',
							finished: true,
							unthreadedBugs: 2,
						}
						fixture.fake.comments.push({
							...summary(),
							body: toMarkerComment('summary', prior),
						})
						fixture.fake.command.pullRequest = {
							...fixture.fake.command.pullRequest,
							head: {
								...fixture.fake.command.pullRequest.head,
								sha: 'moved-head',
							},
						}
						expect(
							yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									command: { agentOnly: false },
									report: {
										...fixture.input.report,
										bugs: [bug({ path: 'outside-new.ts' })],
									},
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({
							verdict: 'needs fixes',
							openBugs: sameHead ? 3 : 1,
							finished: sameHead,
						})
						expect(
							parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
						).toEqual({ ...prior, runs: 2, unthreadedBugs: sameHead ? 3 : 2 })
						expect(fixture.fake.threads).toEqual([])
					})
			)

		for (const place of ['summary', 'unposted'] as const)
			test.effect(
				`a ${place} bug survives a clean single-agent command until a clean full review`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						if (place === 'unposted')
							fixture.fake.failures.review.push(error(503))
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						const reviewed = {
							...fixture.input.report,
							bugs: [
								bug({
									path: place === 'summary' ? 'outside-diff.ts' : bug().path,
								}),
							],
						}
						expect(
							yield* publisher.publish({ ...fixture.input, report: reviewed })
						).toMatchObject({
							verdict: 'needs fixes',
							openBugs: 1,
							finished: true,
							inSummary: place === 'summary' ? 1 : 0,
							unposted: place === 'unposted' ? 1 : 0,
						})
						const marker = {
							v: SUMMARY_MARKER.v,
							runs: 1,
							head: fixture.head,
							finished: true,
							unthreadedBugs: 1,
						}
						expect(
							parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
						).toEqual(marker)
						expect(fixture.fake.threads).toEqual([])
						expect(fixture.fake.comments[0]?.body).not.toContain(
							'from earlier runs on this head still count'
						)
						const clean = {
							...fixture.input,
							report: { ...fixture.input.report, bugs: [] },
						}
						expect(
							yield* publisher.publish({
								...clean,
								command: { agentOnly: true },
							})
						).toMatchObject({
							verdict: 'needs fixes',
							openBugs: 1,
							finished: true,
						})
						expect(
							parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
						).toEqual({ ...marker, runs: 2 })
						expect(fixture.fake.comments[0]?.body).toContain(
							'1 bug(s) without a thread from earlier runs on this head still count until a full review checks them again.'
						)
						expect(yield* publisher.publish(clean)).toMatchObject({
							verdict: 'ready',
							openBugs: 0,
							finished: true,
						})
						expect(
							parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
						).toEqual({
							v: SUMMARY_MARKER.v,
							runs: 3,
							head: fixture.head,
							finished: true,
						})
						expect(fixture.fake.comments[0]?.body).not.toContain(
							'from earlier runs on this head still count'
						)
					})
			)
		test.effect(
			'a full unfinished run counts the unthreaded bugs of the last full review',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const marker = {
						...SUMMARY_MARKER,
						head: fixture.head,
						finished: true,
						unthreadedBugs: 2,
					}
					fixture.fake.comments.push({
						...summary(),
						body: toMarkerComment('summary', marker),
					})
					expect(
						yield* PublishService.use(publisher =>
							publisher.publish({
								...fixture.input,
								report: {
									...fixture.input.report,
									bugs: [],
									endpointError: 'offline',
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						verdict: 'needs fixes',
						openBugs: 2,
						finished: false,
					})
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
					).toEqual({ ...marker, runs: 2, finished: false })
				})
		)
		for (const commandHead of ['same', 'moved', 'unreadable'] as const)
			for (const sameMarkerHead of [false, true])
				test.effect(
					`a ${commandHead} command counts prior bugs only on the recorded head, same=${sameMarkerHead}`,
					() =>
						Effect.gen(function* () {
							const fixture = setup()
							const marker = {
								...SUMMARY_MARKER,
								head: sameMarkerHead ? fixture.head : 'other-head',
								finished: true,
								unthreadedBugs: 2,
							}
							fixture.fake.comments.push({
								...summary(),
								body: toMarkerComment('summary', marker),
							})
							if (commandHead === 'moved')
								fixture.fake.command.pullRequest = {
									...fixture.fake.command.pullRequest,
									head: {
										...fixture.fake.command.pullRequest.head,
										sha: 'new-head',
									},
								}
							if (commandHead === 'unreadable')
								fixture.fake.failures.getPullRequest.push(error(503))
							expect(
								yield* PublishService.use(publisher =>
									publisher.publish({
										...fixture.input,
										command: { agentOnly: commandHead === 'same' },
										report: { ...fixture.input.report, bugs: [] },
									})
								).pipe(Effect.provide(fixture.publisher))
							).toMatchObject({
								verdict: sameMarkerHead ? 'needs fixes' : 'incomplete',
								openBugs: sameMarkerHead ? 2 : 0,
								finished: sameMarkerHead,
							})
							expect(
								parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
							).toEqual({ ...marker, runs: 2 })
						})
				)
		test.effect('a partial run adds its own bug to the carried count', () =>
			Effect.gen(function* () {
				const fixture = setup()
				const marker = {
					...SUMMARY_MARKER,
					head: fixture.head,
					finished: true,
					unthreadedBugs: 2,
				}
				fixture.fake.comments.push({
					...summary(),
					body: toMarkerComment('summary', marker),
				})
				expect(
					yield* PublishService.use(publisher =>
						publisher.publish({
							...fixture.input,
							command: { agentOnly: true },
						})
					).pipe(Effect.provide(fixture.publisher))
				).toMatchObject({ verdict: 'needs fixes', openBugs: 3 })
				expect(
					parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
				).toEqual({ ...marker, runs: 2 })
				expect(fixture.fake.comments[0]?.body).toContain(
					'2 bug(s) without a thread from earlier runs on this head'
				)
			})
		)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService fresh thread count',
	test => {
		for (const resolved of [false, true])
			test.effect(
				`a failed second read uses the first read with locally resolved=${resolved} and counts posted line and file bugs`,
				() =>
					Effect.gen(function* () {
						const applySpy =
							vi.fn<ThreadResolutionService['Service']['apply']>()
						const fixture = setupOverlap(applySpy)
						fixture.fake.threads.push(
							reviewThread(
								{
									finding: bug({ fingerprint: 'old-bug', path: 'old.ts' }),
									kind: 'bug',
								},
								{ id: 'rechecked' }
							),
							reviewThread(
								{
									finding: bug({ fingerprint: 'still-open', path: 'other.ts' }),
									kind: 'bug',
								},
								{ id: 'retained' }
							)
						)
						applySpy.mockImplementation(input =>
							Effect.sync(() => {
								expect(fixture.fake.threadReads).toEqual([17])
								fixture.fake.failures.listThreads.push(error(503))
								return resolved
									? input.threads
											.filter(thread => thread.id === 'rechecked')
											.map(thread => ({
												thread,
												reason: 'The write is guarded.',
											}))
									: []
							})
						)
						expect(
							yield* PublishService.use(publisher =>
								publisher.publish({
									...fixture.input,
									report: {
										...fixture.input.report,
										bugs: [bug(), bug({ line: 30, fingerprint: 'file-bug' })],
									},
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({
							onLine: 1,
							onFile: 1,
							openBugs: resolved ? 3 : 4,
							resolved: resolved ? 1 : 0,
							verdict: 'needs fixes',
						})
						expect(fixture.fake.threadReads).toEqual([17, 17])
						expect(fixture.fake.failures.listThreads).toEqual([])
						expect(
							fixture.fake.threads.map(thread => thread.subjectType)
						).toEqual(['LINE', 'LINE', 'LINE', 'FILE'])
						expect(fixture.fake.comments[0]?.body).toContain(
							`${resolved ? 3 : 4} open bug thread(s)`
						)
					})
			)
		for (const change of ['posted', 'resolved'] as const)
			test.effect(`counts a bug ${change} between thread reads`, () =>
				Effect.gen(function* () {
					const fixture = setup()
					const thread = reviewThread()
					fixture.fake.threadSnapshots.push(
						change === 'resolved' ? [thread] : [],
						[{ ...thread, isResolved: change === 'resolved' }]
					)
					expect(
						yield* PublishService.use(publisher =>
							publisher.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [] },
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						openBugs: change === 'posted' ? 1 : 0,
						verdict: change === 'posted' ? 'needs fixes' : 'ready',
						resolved: 0,
						onLine: 0,
						onFile: 0,
					})
					expect(fixture.fake.threadReads).toEqual([17, 17])
					expect(fixture.fake.threadSnapshots).toEqual([])
				})
			)
		test.effect(
			'a concurrent thread with the planned fingerprint counts once after posting',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threadSnapshots.push([], [reviewThread()])
					expect(
						yield* PublishService.use(publisher =>
							publisher.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ onLine: 1, openBugs: 1, verdict: 'needs fixes' })
					expect(fixture.fake.threadReads).toEqual([17, 17])
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
							?.unthreadedBugs
					).toBeUndefined()
				})
		)
		test.effect(
			'counts this run line and file bugs once each alongside another run thread',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threadSnapshots.push(
						[],
						[
							reviewThread(),
							reviewThread(
								{
									finding: bug({ line: 30, fingerprint: 'file-bug' }),
									kind: 'bug',
								},
								{ id: 'file-thread', subjectType: 'FILE' }
							),
							reviewThread(
								{
									finding: bug({
										path: 'other.ts',
										fingerprint: 'concurrent-bug',
									}),
									kind: 'bug',
								},
								{ id: 'concurrent' }
							),
						]
					)
					expect(
						yield* PublishService.use(publisher =>
							publisher.publish({
								...fixture.input,
								report: {
									...fixture.input.report,
									bugs: [
										bug(),
										bug({
											line: 30,
											fingerprint: 'file-bug',
											title: 'Missing guard corrupts storage',
										}),
									],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						onLine: 1,
						onFile: 1,
						openBugs: 3,
						verdict: 'needs fixes',
					})
					expect(
						fixture.fake.threads.map(thread => thread.subjectType)
					).toEqual(['LINE', 'FILE'])
					expect(fixture.fake.threadReads).toEqual([17, 17])
				})
		)
	}
)
