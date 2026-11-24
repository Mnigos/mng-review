import { layer } from '@effect/vitest'
import { GitError, GitService } from '@mng-review/engine'
import { Effect, Layer, Redacted } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { RECENT_COMMENTS } from '../../../platform/github-api.constants'
import type { ReviewThread } from '../../../platform/github-api.schema'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { provideOwnedIdentities } from '../../../platform/owned-identities.context'
import { agent, file } from '../../../shared/mocks/domain-test.helper'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { readThreadOverHttp } from '../../../shared/mocks/github-http.helper'
import {
	githubStatusFake,
	openPullRequest,
} from '../../../shared/mocks/github-status-fake.helper'
import {
	ACCEPTING_RULES,
	APP_IDENTITY,
	APP_MODE_OWNED,
	bug,
	botThread,
	botClosedReviewThread,
	agentReport,
	report,
	RULES,
	reviewAnswers,
	reviewThread,
	threadReply,
	SUMMARY_MARKER,
	summaryReview,
	TOKEN_MODE_OWNED,
} from '../../../shared/mocks/publish-test.helper'
import {
	ACCEPTED_DECISION,
	editedOwnerReviewThread,
	markedThreadReply,
	ownerReviewThread,
	decidedReply,
	pendingReviewThread,
	unsettledBugThread,
} from '../../../shared/mocks/thread-reply-test.helper'
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
import { toBodyDigest } from '../domain/bot-thread.helper'
import {
	parseFindingMarker,
	parseReplyMarker,
	parseSummaryMarker,
} from '../domain/publish-marker.parser'
import {
	MAX_ANSWER_ENTRIES,
	THREAD_PLACE_LINES,
} from '../domain/publish.constants'
import { PublishIncompleteError } from '../domain/publish.errors'
import type { ThreadReplyDecision } from '../domain/thread-reply.schema'
import {
	formatReviewHeadline,
	toBodyWithHeadline,
	toBodyWithoutHeadline,
} from '../presentation/review-headline.formatter'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import { PublishService, PublishServiceLive } from './publish.service'
import {
	SummaryReviewService,
	SummaryReviewServiceLive,
} from './summary-review.service'
import {
	ThreadResolutionService,
	ThreadResolutionServiceLive,
} from './thread-resolution.service'

/** The head check, then the summary write's reads before the review, the cleanup and the dismissals. */
const HEAD_READS = Array.from({ length: 4 }, () => 'getPullRequest:17')
const NO_DISMISSAL = { dismissed: 0, failed: 0 } as const

/** `ACCEPTED_DECISION` citing a line the pull request did not change, so publishing's check passes. */
const ACCEPTED_ON_KEPT_LINE = {
	...ACCEPTED_DECISION,
	evidence: ['src/store.ts:12'],
} as const satisfies ThreadReplyDecision

/** Real git history with a finding on a changed head line and a recording API. */
/** The in-memory GitHub of these specs. */
type GitHubApiFake = ReturnType<typeof githubApiFake>

/** Points the pull request the fake serves at `head`, as a push to it does. */
function moveHead(fake: GitHubApiFake, head: string): void {
	fake.command.pullRequest = {
		...fake.command.pullRequest,
		head: { ...fake.command.pullRequest.head, sha: head },
	}
}

function setup(
	apply?: ThreadResolutionService['Service']['apply'],
	identity = GITHUB_ACTIONS_IDENTITY,
	basePath = bug().path
) {
	const repo = createRepo()
	const original = `${Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
	repo.write(basePath, original)
	const base = repo.commit()
	if (basePath !== bug().path) repo.git('mv', basePath, bug().path)
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
		Layer.provideMerge(SummaryReviewServiceLive),
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
		state: 'COMMENTED' as const,
		isMinimized: false,
		body: toMarkerComment('summary', SUMMARY_MARKER),
		author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
		editor: null,
	}
}

/** The body of the newest review, which holds the summary. */
function reviewBody(fake: ReturnType<typeof githubApiFake>) {
	return fake.reviews.at(-1)?.body
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
					])
					const [review] = fixture.fake.writes
					expect(review).toMatchObject({
						method: 'review',
						pullNumber: 17,
						input: {
							commitId: fixture.head,
							event: 'REQUEST_CHANGES',
							body: reviewBody(fixture.fake),
							comments: [{ path: bug().path, line: bug().line }],
						},
					})
					expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.runs).toBe(
						1
					)
					expect(yield* publisher.publish(fixture.input)).toMatchObject({
						onLine: 0,
						repeated: 1,
						run: 2,
					})
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'review',

						'updateReview',
					])
					expect(
						parseSummaryMarker(reviewBody(fixture.fake) ?? '')
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
					fixture.fake.reviews.push(existing)
					fixture.fake.failures.review.push(failure)
					const failed = yield* PublishService.use(service =>
						service.publish({
							...fixture.input,
							report: { ...fixture.input.report, bugs: [bug({ line: 30 })] },
						})
					).pipe(Effect.provide(fixture.publisher), Effect.flip)
					expect(failed).toBeInstanceOf(PublishIncompleteError)
					expect(failed).toEqual(new PublishIncompleteError({ error: failure }))
					expect(failed.message).toBe(failure.message)
					expect(fixture.fake.writes.map(write => write.method)).toEqual([
						'comment',
						'review',
					])
					expect(fixture.fake.threads).toHaveLength(1)
					expect(fixture.fake.reviews).toEqual([existing])
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
				`422 review falls back to the body with ${refusals} unrelated comment refusals queued`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.failures.review.push(error(422))
						fixture.fake.failures.comment.push(
							...Array.from({ length: refusals }, () => error(422))
						)
						expect(
							yield* PublishService.use(service =>
								service.publish(fixture.input)
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({ onLine: 0, onFile: 0, inSummary: 1, unposted: 0 })
						expect(fixture.fake.writes.map(write => write.method)).toEqual([
							'review',
							'review',
						])
						expect(
							fixture.fake.writes.filter(write => write.method === 'comment')
						).toEqual([])
						expect(fixture.fake.failures.comment).toHaveLength(refusals)
						expect(
							parseSummaryMarker(reviewBody(fixture.fake) ?? '')
						).toMatchObject({
							head: fixture.head,
							finished: true,
							unthreadedBugs: 1,
						})
						expect(reviewBody(fixture.fake)).toContain('Not in the diff (1):')
					})
			)
		for (const status of [500, 503, undefined])
			test.effect(
				`unknown review result ${status} fails closed without a duplicate review`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const failure = error(status)
						fixture.fake.failures.review.push(failure)
						expect(
							yield* PublishService.use(service =>
								service.publish(fixture.input)
							).pipe(Effect.provide(fixture.publisher), Effect.flip)
						).toEqual(new PublishIncompleteError({ error: failure }))
						expect(fixture.fake.writes.map(write => write.method)).toEqual([
							'review',
						])
						expect(fixture.fake.reviewReads).toEqual([17, 17, 17])
						expect(fixture.fake.reviews).toEqual([])
						expect(fixture.fake.threads).toEqual([])
					})
			)
		test.effect('recreates a summary whose update returned 404', () =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(summary())
				fixture.fake.failures.updateReview.push(error(404))
				const publisher = yield* PublishService.pipe(
					Effect.provide(fixture.publisher)
				)
				yield* publisher.publish({
					...fixture.input,
					report: { ...fixture.input.report, bugs: [] },
				})
				expect(fixture.fake.writes.map(call => call.method)).toEqual([
					'updateReview',
					'review',
					'minimize',
				])
				expect(fixture.fake.writes[0]).toMatchObject({
					method: 'updateReview',
					id: 101,
				})
			})
		)
		test.effect(
			'status creates an unfinished summary and then updates it without another comment',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const publisher = yield* SummaryReviewService.pipe(
						Effect.provide(fixture.publisher)
					)
					const input = {
						pullNumber: 17,
						head: fixture.head,
						engineCommit: undefined,
						status: 'Reviewer offline',
					}
					expect(yield* publisher.publishStatus(input)).toMatchObject({
						created: true,
					})
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'review',
					])
					expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
						v: SUMMARY_MARKER.v,
						runs: 0,
						finished: false,
					})
					const originalBody = reviewBody(fixture.fake)
					expect(
						yield* publisher.publishStatus({
							...input,
							status: 'Another failure',
						})
					).toMatchObject({ created: false })
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'review',
						'updateReview',
					])
					expect(reviewBody(fixture.fake)).toBe(originalBody)
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
					moveHead(fixture.fake, head)
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
								Layer.provide(SummaryReviewServiceLive),
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
						'review',
					])
					expect(reviewBody(fixture.fake)).toContain(
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
						moveHead(fixture.fake, head)
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
							'review',
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
							parseSummaryMarker(reviewBody(fixture.fake) ?? '')
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
									openPullRequest(fixture.input.pullNumber, fixture.head),
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
						).toEqual({
							checked: 1,
							updated: 0,
							failed: 0,
							dismissal: NO_DISMISSAL,
						})
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
					const body = reviewBody(fixture.fake) ?? ''
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
							'review',
						])
						expect(fixture.fake.threads).toEqual([])
						expect(reviewBody(fixture.fake)).toContain(
							'About the pull request (1):'
						)
						const marker = parseSummaryMarker(reviewBody(fixture.fake) ?? '')
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
					expect(reviewBody(fixture.fake)).toContain(
						'About the pull request (1):'
					)
					expect(reviewBody(fixture.fake)).toContain('Not in the diff (1):')
					expect(
						parseSummaryMarker(reviewBody(fixture.fake) ?? '')
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
				`review error ${status} preserves an earlier file post and does not repost`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const failure = error(status)
						fixture.fake.failures.review.push(failure)
						expect(
							yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									report: {
										...fixture.input.report,
										bugs: [bug(), bug({ line: 30, fingerprint: 'file-bug' })],
									},
								})
							).pipe(Effect.provide(fixture.publisher), Effect.flip)
						).toEqual(new PublishIncompleteError({ error: failure }))
						expect(fixture.fake.writes.map(write => write.method)).toEqual([
							'comment',
							'review',
						])
						expect(
							fixture.fake.threads.map(thread => thread.subjectType)
						).toEqual(['FILE'])
					})
			)
		test.effect(
			'uses the newest eligible bot summary and ignores human-edited markers',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(
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
					yield* publisher.publish({
						...fixture.input,
						report: { ...fixture.input.report, bugs: [] },
					})
					expect(
						fixture.fake.writes
							.filter(call => call.method === 'updateReview')
							.map(call => call.id)
					).toEqual([4])
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
					fixture.fake.reviews.push(existing)
					const publisher = yield* SummaryReviewService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(
						yield* publisher.publishStatus({
							pullNumber: 17,
							head: fixture.head,
							engineCommit: 'engine',
							status: 'offline',
						})
					).toMatchObject({ created: false })
					const body = toBodyWithHeadline(
						`Verdict: ready\n${toMarkerComment('summary', { ...SUMMARY_MARKER, finished: false })}`,
						formatReviewHeadline({
							event: 'COMMENT',
							evidence: { kind: 'offline', authored: false },
							keep: true,
						})
					)
					expect(fixture.fake.writes).toEqual([
						{ method: 'updateReview', id: existing.databaseId, body },
					])
					expect(fixture.fake.reviews).toEqual([{ ...existing, body }])
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
						'review',
					])
				})
		)
		test.effect(
			'a sweep after an offline run uses the unfinished marker instead of an earlier successful verdict',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push({
						...summary(),
						body: `Verdict: ready\n${toMarkerComment('summary', { ...SUMMARY_MARKER, finished: true })}`,
					})
					fixture.fake.threads.push(botClosedReviewThread())
					expect(
						yield* SummaryReviewService.use(publisher =>
							publisher.publishStatus({
								pullNumber: 17,
								head: fixture.head,
								engineCommit: undefined,
								status: 'offline',
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ created: false })
					const status = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, fixture.head)]),
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
					).toEqual({
						checked: 1,
						updated: 1,
						failed: 0,
						dismissal: NO_DISMISSAL,
					})
					expect(status.statuses).toEqual([
						{ sha: fixture.head, ...toCommitStatus('incomplete', 0, false) },
					])
					expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
						...SUMMARY_MARKER,
						finished: false,
					})
				})
		)
		test.effect(
			'an existing summary update failure is reported without creating another comment',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const existing = summary()
					fixture.fake.reviews.push(existing)
					const failure = error(403)
					fixture.fake.failures.updateReview.push(failure)
					expect(
						yield* SummaryReviewService.use(publisher =>
							publisher.publishStatus({
								pullNumber: 17,
								head: fixture.head,
								engineCommit: undefined,
								status: 'offline',
							})
						).pipe(Effect.provide(fixture.publisher), Effect.flip)
					).toEqual(failure)
					expect(fixture.fake.writes.map(write => write.method)).toEqual([
						'updateReview',
					])
					expect(fixture.fake.reviews).toEqual([existing])
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
						const summaryBody = reviewBody(fixture.fake) ?? ''
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
								fixture.fake.reviews.push({
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
							const summaries = yield* SummaryReviewService.pipe(
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
								parseSummaryMarker(reviewBody(fixture.fake) ?? '')
							).toEqual(marker)
							expect(
								yield* summaries.readPrior(fixture.input.pullNumber)
							).toEqual(marker)
						})
				)
		test.effect('offline summary has no reviewed head and zero runs', () =>
			Effect.gen(function* () {
				const fixture = setup()
				const publisher = yield* SummaryReviewService.pipe(
					Effect.provide(fixture.publisher)
				)
				yield* publisher.publishStatus({
					pullNumber: 17,
					head: fixture.head,
					engineCommit: 'engine',
					status: 'offline',
				})
				expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
					v: SUMMARY_MARKER.v,
					runs: 0,
					finished: false,
				})
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
					moveHead(fixture.fake, head)
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
						'review',
					])
					const body = reviewBody(fixture.fake) ?? ''
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
							'review',
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
							latestDigest: toBodyDigest(
								reviewThread().comments.nodes[0]?.body ?? ''
							),
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
						).toHaveLength(1)
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
					).toHaveLength(1)
				})
		)
	}
)

/** Runs the supplied resolution fake between the first thread read and the summary write. */
/** The thread with every comment on `commit`, so publishing's git checks read it there. */
function atCommit(thread: ReviewThread, commit: string): ReviewThread {
	return {
		...thread,
		comments: {
			...thread.comments,
			nodes: thread.comments.nodes.map(comment => ({
				...comment,
				originalCommit: { oid: commit },
			})),
		},
	}
}

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
							fixture.fake.reviews.push({
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
							parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.manualRuns
						).toBe(previous === 'none' ? undefined : 2)
					})
			)
		for (const agentOnly of [false, true])
			test.effect(
				`publishing a command with agentOnly=${agentOnly} retains the reserved manual run count across publishes`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.reviews.push({
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
								parseSummaryMarker(reviewBody(fixture.fake) ?? '')
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
									fixture.fake.reviews.push({
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
										fixture.fake.reviews.splice(
											0,
											fixture.fake.reviews.length,
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
								const body = reviewBody(fixture.fake) ?? ''
								expect(parseSummaryMarker(body)).toEqual({ ...fresh, runs: 8 })
								expect(body).toContain(`**Verdict: ${verdict}**`)
								expect(body).toContain('run 8 of')
								expect(
									fixture.fake.writes.filter(
										write => write.method === 'updateReview'
									)
								).toEqual(
									hasBug ? [] : [{ method: 'updateReview', id: 202, body }]
								)
								expect(fixture.fake.reads).toEqual(HEAD_READS)
							})
					)
		for (const finished of [false, true])
			test.effect(
				`push reads the head again and uses its own finished=${finished} and the fresh run count`,
				() =>
					Effect.gen(function* () {
						const applySpy =
							vi.fn<ThreadResolutionService['Service']['apply']>()
						const fixture = setupOverlap(applySpy)
						fixture.fake.reviews.push(summary())
						const fresh = {
							...SUMMARY_MARKER,
							head: 'new-full-review-head',
							runs: 7,
							manualRuns: 3,
							finished: !finished,
						}
						applySpy.mockImplementation(() =>
							Effect.sync(() => {
								fixture.fake.reviews.splice(0, 1, {
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
						const body = reviewBody(fixture.fake) ?? ''
						expect(parseSummaryMarker(body)).toEqual({
							...fresh,
							runs: 8,
							head: finished ? fixture.head : fresh.head,
							finished,
						})
						expect(body).toContain(`**Verdict: ${verdict}**`)
						expect(body).not.toContain('Other run details.')
						expect(fixture.fake.reads).toEqual(HEAD_READS)
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
					fixture.fake.reviews.push({
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
					expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
						...SUMMARY_MARKER,
						runs: 5,
						manualRuns: 2,
						head: fixture.head,
						finished: true,
					})
					expect(reviewBody(fixture.fake)).toContain('**Verdict: ready**')
					expect(reviewBody(fixture.fake)).not.toContain(
						'Stale review details.'
					)
					expect(fixture.fake.reads).toEqual(HEAD_READS)
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
								fixture.fake.reviews.push({
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
							const body = reviewBody(fixture.fake) ?? ''
							expect(parseSummaryMarker(body)).toEqual(
								previous === 'none'
									? { v: SUMMARY_MARKER.v, runs: 1, finished: false }
									: { ...prior, runs: 5 }
							)
							if (previous === 'none')
								expect(body).toContain(`**Verdict: ${verdict}**`)
							else
								expect(
									toBodyWithoutHeadline(body).replace(
										/<!-- mng-review:summary .* -->$/u,
										''
									)
								).toBe(visible)
							expect(fixture.fake.reads).toEqual(HEAD_READS)
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
							fixture.fake.threads.push(reviewThread())
							fixture.fake.reviews.push({
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
									fixture.fake.reviews.splice(0, 1, {
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
							const body = reviewBody(fixture.fake) ?? ''
							expect(parseSummaryMarker(body)).toEqual({ ...fresh, runs: 8 })
							expect(
								toBodyWithoutHeadline(body).replace(
									/<!-- mng-review:summary .* -->$/u,
									''
								)
							).toBe(visible)
							// A head that moved or cannot be read is no evidence: the newest review keeps its state.
							expect(
								fixture.fake.writes.filter(
									write =>
										write.method === 'review' || write.method === 'updateReview'
								)
							).toEqual([{ method: 'updateReview', id: 202, body }])
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
									fixture.fake.reviews.push({
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
								const body = reviewBody(fixture.fake) ?? ''
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
										toBodyWithoutHeadline(body).replace(
											/<!-- mng-review:summary .* -->$/u,
											''
										)
									).toBe(visible)
								}
								expect(fixture.fake.writes.map(write => write.method)).toEqual([
									previous === 'none' ? 'review' : 'updateReview',
								])
								expect(fixture.fake.reads).toEqual(HEAD_READS)
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
						expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
							v: SUMMARY_MARKER.v,
							runs: 1,
							head: fixture.head,
							finished: true,
						})
						if (place === 'unposted')
							fixture.fake.failures.comment.push(error(503))
						const published = yield* publisher.publish({
							...fixture.input,
							command: { agentOnly: true },
							report: {
								...fixture.input.report,
								bugs: [
									bug({
										path: place === 'summary' ? 'outside-diff.ts' : bug().path,
										line: place === 'unposted' ? 30 : bug().line,
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
						expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
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
									openPullRequest(fixture.input.pullNumber, fixture.head),
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
						).toEqual({
							checked: 1,
							updated: 0,
							failed: 0,
							dismissal: NO_DISMISSAL,
						})
						expect(statuses.statuses).toEqual([])
						expect(statuses.statuses.at(-1)?.state ?? status.state).toBe(
							'failure'
						)
						expect(yield* publisher.publish(clean)).toMatchObject({
							verdict: 'ready',
							openBugs: 0,
							finished: true,
						})
						expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
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
								parseSummaryMarker(reviewBody(fixture.fake) ?? '')
							).toEqual({
								v: SUMMARY_MARKER.v,
								runs: 1,
								head: fixture.head,
								finished: true,
								unthreadedBugs: 2,
							})
							if (place === 'unposted')
								fixture.fake.failures.comment.push(error(503))
							const reviewed = {
								...fixture.input.report,
								bugs:
									place === 'none'
										? []
										: [
												bug({
													path:
														place === 'summary' ? 'outside-new.ts' : bug().path,
													line: place === 'unposted' ? 30 : bug().line,
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
								parseSummaryMarker(reviewBody(fixture.fake) ?? '')
							).toEqual({
								v: SUMMARY_MARKER.v,
								runs: 2,
								head: fixture.head,
								finished: false,
								unthreadedBugs: openBugs,
							})
							expect(reviewBody(fixture.fake)).toContain(
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
								parseSummaryMarker(reviewBody(fixture.fake) ?? '')
							).toEqual({
								v: SUMMARY_MARKER.v,
								runs: 3,
								head: fixture.head,
								finished: true,
							})
							expect(reviewBody(fixture.fake)).not.toContain(
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
						fixture.fake.reviews.push({
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
						expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
							...prior,
							runs: 2,
							unthreadedBugs: sameHead ? 3 : 2,
						})
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
							fixture.fake.failures.comment.push(error(503))
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						const reviewed = {
							...fixture.input.report,
							bugs: [
								bug({
									path: place === 'summary' ? 'outside-diff.ts' : bug().path,
									line: place === 'unposted' ? 30 : bug().line,
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
						expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual(
							marker
						)
						expect(fixture.fake.threads).toEqual([])
						expect(reviewBody(fixture.fake)).not.toContain(
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
						expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
							...marker,
							runs: 2,
						})
						expect(reviewBody(fixture.fake)).toContain(
							'1 bug(s) without a thread from earlier runs on this head still count until a full review checks them again.'
						)
						expect(yield* publisher.publish(clean)).toMatchObject({
							verdict: 'ready',
							openBugs: 0,
							finished: true,
						})
						expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
							v: SUMMARY_MARKER.v,
							runs: 3,
							head: fixture.head,
							finished: true,
						})
						expect(reviewBody(fixture.fake)).not.toContain(
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
					fixture.fake.reviews.push({
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
					expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
						...marker,
						runs: 2,
						finished: false,
					})
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
							fixture.fake.reviews.push({
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
								parseSummaryMarker(reviewBody(fixture.fake) ?? '')
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
				fixture.fake.reviews.push({
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
				expect(parseSummaryMarker(reviewBody(fixture.fake) ?? '')).toEqual({
					...marker,
					runs: 2,
				})
				expect(reviewBody(fixture.fake)).toContain(
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
						).toEqual(['LINE', 'LINE', 'FILE', 'LINE'])
						expect(reviewBody(fixture.fake)).toContain(
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
						parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.unthreadedBugs
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
					).toEqual(['FILE', 'LINE'])
					expect(fixture.fake.threadReads).toEqual([17, 17])
				})
		)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService author replies',
	test => {
		test.effect(
			'a held answer that reopens a resolved bug thread counts it open after a failed second read',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push({
						...pendingReviewThread(),
						isResolved: true,
						resolvedBy: { login: 'contributor' },
					})
					fixture.fake.threadComments.set('thread', [
						threadReply({
							databaseId: 42,
							body: pendingReviewThread().latest?.nodes[0]?.body ?? '',
							createdAt: '2026-01-01T12:00:00Z',
							author: { __typename: 'User', login: 'contributor' },
						}),
					])
					fixture.fake.failures.listThreads.push(undefined, error())
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [] },
								run: 7,
								held: 42,
								replies: {
									tokens: {},
									base: fixture.base,
									decisions: [
										decidedReply({
											action: 'still-found',
											reason: 'The write repeats.',
										}),
									],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ answered: { 'still-found': 1 }, openBugs: 1 })
				})
		)
		for (const touched of [false, true])
			test.effect(
				`resolved applies only after the finding file was touched: ${touched}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const commit = touched ? fixture.base : fixture.head
						fixture.repo.write('unrelated.ts', 'another change\n')
						const head = fixture.repo.commit()
						fixture.fake.command.pullRequest = {
							...fixture.fake.command.pullRequest,
							head: { ...fixture.fake.command.pullRequest.head, sha: head },
						}
						fixture.fake.threads.push(atCommit(pendingReviewThread(), commit))
						expect(
							yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									head,
									replies: {
										base: fixture.base,
										tokens: {},
										decisions: [
											decidedReply({
												action: 'resolved',
												reason: 'The guard fixes it.',
											}),
										],
									},
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({
							answered: touched ? { resolved: 1 } : {},
							openBugs: touched ? 0 : 1,
							verdict: touched ? 'ready' : 'needs fixes',
						})
						expect(
							fixture.fake.writes
								.filter(
									write =>
										write.method === 'reply' || write.method === 'resolve'
								)
								.map(write => write.method)
						).toEqual(touched ? ['reply', 'resolve'] : [])
						expect(
							fixture.fake.threads.find(thread => thread.id === 'thread')
								?.isResolved
						).toBe(touched)
					})
			)
		for (const mixed of [false, true])
			test.effect(
				`accepted applies with only valid citations in its answer, mixed=${mixed}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.threads.push(pendingReviewThread())
						const evidence = mixed
							? [
									'src/store.ts:10',
									'src/store.ts:12',
									'missing.ts:1',
									'src/store.ts:41',
									'src/store.ts:20',
								]
							: ['src/store.ts:12']
						expect(
							yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									rules: ACCEPTING_RULES,
									replies: {
										base: fixture.base,
										tokens: {},
										decisions: [
											decidedReply({ ...ACCEPTED_DECISION, evidence }),
										],
									},
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({
							answered: { accepted: 1 },
							openBugs: 0,
							verdict: 'ready',
						})
						const answer = fixture.fake.writes.find(
							write => write.method === 'reply'
						)
						expect(answer?.method).toBe('reply')
						if (answer?.method !== 'reply') return
						expect(answer.body).toContain('`src/store.ts:12`')
						if (mixed) expect(answer.body).toContain('`src/store.ts:20`')
						for (const invalid of [
							'src/store.ts:10',
							'missing.ts:1',
							'src/store.ts:41',
						])
							expect(answer.body).not.toContain(invalid)
						expect(parseReplyMarker(answer.body)).toMatchObject({
							action: 'accepted',
							commit: fixture.head,
							reply: 42,
						})
						expect(
							fixture.fake.writes
								.filter(
									write =>
										write.method === 'reply' || write.method === 'resolve'
								)
								.map(write => write.method)
						).toEqual(['reply', 'resolve'])
						expect(
							fixture.fake.threads.find(thread => thread.id === 'thread')
								?.isResolved
						).toBe(true)
					})
			)
		test.effect(
			'accepted with only a line added by the pull request leaves the thread open',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push(pendingReviewThread())
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules: ACCEPTING_RULES,
								replies: {
									base: fixture.base,
									tokens: {},
									decisions: [decidedReply(ACCEPTED_DECISION)],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ answered: {}, openBugs: 1, verdict: 'needs fixes' })
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'reply' || write.method === 'resolve'
						)
					).toEqual([])
					expect(
						fixture.fake.threads.find(thread => thread.id === 'thread')
							?.isResolved
					).toBe(false)
				})
		)

		for (const scenario of [
			{
				name: 'critical severity from the bot marker',
				severity: 'critical',
				config: {
					...ACCEPTING_RULES.config,
					disputes: {
						...ACCEPTING_RULES.config.disputes,
						accept_intentional_up_to: 'critical',
					},
				},
			},
			{
				name: 'a file under the base rules risk_paths',
				severity: 'high',
				config: { ...ACCEPTING_RULES.config, risk_paths: ['src/**'] },
			},
			{
				name: 'severity above the base rules limit',
				severity: 'high',
				config: RULES.config,
			},
		] as const)
			test.effect(`accepted drops ${scenario.name} through publishing`, () =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push(
						pendingReviewThread({
							comments: {
								...reviewThread({
									finding: bug({ severity: scenario.severity }),
									kind: 'bug',
								}).comments,
								totalCount: 2,
							},
						})
					)
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules: { ...ACCEPTING_RULES, config: scenario.config },
								replies: {
									base: fixture.base,
									tokens: {},
									decisions: [decidedReply(ACCEPTED_ON_KEPT_LINE)],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						answered: {},
						openBugs: 1,
						verdict: 'needs fixes',
					})
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'reply' || write.method === 'resolve'
						)
					).toEqual([])
				})
			)
		test.effect(
			'accepted within the base rules limit replies and resolves through publishing',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push(
						pendingReviewThread({
							comments: {
								...reviewThread({
									finding: bug({ severity: 'high' }),
									kind: 'bug',
								}).comments,
								totalCount: 2,
							},
						})
					)
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules: ACCEPTING_RULES,
								replies: {
									base: fixture.base,
									tokens: {},
									decisions: [decidedReply(ACCEPTED_ON_KEPT_LINE)],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						answered: { accepted: 1 },
						openBugs: 0,
						verdict: 'ready',
					})
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'reply' || write.method === 'resolve'
						)
					).toEqual([
						expect.objectContaining({ method: 'reply', id: 'thread' }),
						{ method: 'resolve', id: 'thread' },
					])
				})
		)
		test.effect(
			'a reply edited after publishing reads the thread is left for a later run',
			() =>
				Effect.gen(function* () {
					const fixture = setupOverlap(() =>
						Effect.sync(() => {
							expect(fixture.fake.threadReads).toEqual([17])
							fixture.fake.threadComments.set('thread', [
								threadReply({
									databaseId: 42,
									body: 'The guard still needs work.',
									author: { __typename: 'User', login: 'contributor' },
								}),
							])
							return []
						})
					)
					fixture.fake.threads.push(pendingReviewThread())
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules: ACCEPTING_RULES,
								replies: {
									base: fixture.base,
									tokens: {},
									decisions: [decidedReply(ACCEPTED_ON_KEPT_LINE)],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						answered: {},
						openBugs: 1,
						verdict: 'needs fixes',
					})
					expect(fixture.fake.reads).toContain('listThreadComments:thread')
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'reply' || write.method === 'resolve'
						)
					).toEqual([])
					expect(fixture.fake.threads[0]?.isResolved).toBe(false)
				})
		)

		for (const forged of ['rename', 'omitted'] as const)
			test.effect(
				`accepted on a real risk path is dropped when the outcome claims ${forged}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.threads.push(pendingReviewThread())
						expect(
							fixture.repo.git(
								'diff',
								'--name-status',
								fixture.base,
								fixture.head
							)
						).toBe(`M\t${bug().path}`)
						expect(
							yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									rules: {
										...ACCEPTING_RULES,
										config: {
											...ACCEPTING_RULES.config,
											risk_paths: ['src/**'],
										},
									},
									report: {
										...fixture.input.report,
										planReport: {
											...fixture.input.report.planReport,
											change: {
												...fixture.input.report.planReport.change,
												files:
													forged === 'rename'
														? [
																file('lib/store.ts', {
																	status: 'renamed',
																	oldPath: bug().path,
																}),
															]
														: [],
											},
										},
									},
									replies: {
										base: fixture.base,
										tokens: {},
										decisions: [decidedReply(ACCEPTED_DECISION)],
									},
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({ answered: {}, openBugs: 1 })
						expect(
							fixture.fake.writes.filter(
								write => write.method === 'reply' || write.method === 'resolve'
							)
						).toEqual([])
					})
			)
		test.effect(
			'accepted is dropped for a real rename out of risk_paths that the outcome hides',
			() =>
				Effect.gen(function* () {
					const fixture = setup(
						undefined,
						GITHUB_ACTIONS_IDENTITY,
						'src/risk/store.ts'
					)
					fixture.fake.threads.push(pendingReviewThread())
					expect(
						(yield* GitService.use(git =>
							git.readChange(fixture.base, fixture.head)
						).pipe(Effect.provide(gitLayer(fixture.repo.root)))).files
					).toMatchObject([
						{
							path: bug().path,
							status: 'renamed',
							oldPath: 'src/risk/store.ts',
						},
					])
					expect(fixture.input.report.planReport.change.files).toMatchObject([
						{ path: bug().path, status: 'modified' },
					])
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules: {
									...ACCEPTING_RULES,
									config: {
										...ACCEPTING_RULES.config,
										risk_paths: ['src/risk/**'],
									},
								},
								replies: {
									base: fixture.base,
									tokens: {},
									decisions: [decidedReply(ACCEPTED_DECISION)],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ answered: {}, openBugs: 1 })
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'reply' || write.method === 'resolve'
						)
					).toEqual([])
				})
		)
		test.effect(
			'a forged rename from risk_paths cannot block accepted on a real unrestricted file',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push(pendingReviewThread())
					expect(
						fixture.repo.git(
							'diff',
							'--name-status',
							fixture.base,
							fixture.head
						)
					).toBe(`M\t${bug().path}`)
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules: {
									...ACCEPTING_RULES,
									config: {
										...ACCEPTING_RULES.config,
										risk_paths: ['src/risk/**'],
									},
								},
								report: {
									...fixture.input.report,
									planReport: {
										...fixture.input.report.planReport,
										change: {
											...fixture.input.report.planReport.change,
											files: [
												file(bug().path, {
													status: 'renamed',
													oldPath: 'src/risk/store.ts',
												}),
											],
										},
									},
								},
								replies: {
									base: fixture.base,
									tokens: {},
									decisions: [decidedReply(ACCEPTED_ON_KEPT_LINE)],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						answered: { accepted: 1 },
						openBugs: 0,
						verdict: 'ready',
					})
					expect(
						fixture.fake.writes
							.filter(
								write => write.method === 'reply' || write.method === 'resolve'
							)
							.map(write => write.method)
					).toEqual(['reply', 'resolve'])
				})
		)
		test.effect(
			'a missing bound base drops accepted while resolved still replies and resolves',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push(
						pendingReviewThread(),
						atCommit(
							pendingReviewThread({ id: 'resolved-thread' }),
							fixture.base
						)
					)
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules: ACCEPTING_RULES,
								replies: {
									base: '0'.repeat(40),
									tokens: {},
									decisions: [
										decidedReply(ACCEPTED_DECISION),
										decidedReply(
											{ action: 'resolved', reason: 'The guard fixes it.' },
											{ threadId: 'resolved-thread' }
										),
									],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ answered: { resolved: 1 } })
					expect(
						fixture.fake.writes.filter(write => write.method === 'reply')
					).toMatchObject([{ id: 'resolved-thread' }])
					expect(
						fixture.fake.writes.filter(write => write.method === 'resolve')
					).toEqual([{ method: 'resolve', id: 'resolved-thread' }])
				})
		)

		for (const action of ['resolved', 'accepted', 'recheck'] as const)
			for (const refused of [false, true])
				test.effect(
					`${action} dismisses a finding changed since its thread commit, resolution refused=${refused}`,
					() =>
						Effect.gen(function* () {
							const fixture = setup()
							const thread =
								action === 'recheck' ? reviewThread() : pendingReviewThread()
							fixture.fake.threads.push({
								...thread,
								comments: {
									...thread.comments,
									nodes: thread.comments.nodes.map(comment => ({
										...comment,
										originalCommit: { oid: fixture.base },
									})),
								},
							})
							expect(
								fixture.repo.git(
									'log',
									'--format=%H',
									`-L${bug().line - THREAD_PLACE_LINES},${bug().line + THREAD_PLACE_LINES}:${bug().path}`,
									`${fixture.base}..${fixture.head}`
								)
							).toContain(fixture.head)
							if (refused) fixture.fake.failures.resolve.push(error(403))
							const closing =
								action === 'recheck'
									? {
											recheck: {
												checked: 1,
												proposals: [
													{
														threadId: thread.id,
														fingerprint: bug().fingerprint,
														reason: 'The write is guarded.',
													},
												],
												tokens: {},
											},
										}
									: {
											replies: {
												tokens: {},
												base: fixture.base,
												decisions: [
													decidedReply(
														action === 'accepted'
															? {
																	action,
																	reason: 'The guard is intentional.',
																	memory: 'Keep the guard.',
																	evidence: ['src/store.ts:12'],
																}
															: { action, reason: 'The guard fixes it.' }
													),
												],
											},
										}
							expect(
								yield* PublishService.use(service =>
									service.publish({
										...fixture.input,
										rules: ACCEPTING_RULES,
										...closing,
									})
								).pipe(Effect.provide(fixture.publisher))
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
							expect(fixture.fake.writes.map(write => write.method)).toEqual([
								'reply',
								'resolve',
								'review',
							])
						})
				)
		test.effect(
			'needs-owner writes one answer, records the thread in the marker and adds the label',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push(pendingReviewThread())
					yield* PublishService.use(service =>
						service.publish({
							...fixture.input,
							replies: {
								tokens: {},
								base: fixture.base,
								decisions: [
									decidedReply({
										action: 'needs-owner',
										reason: 'The disagreement remains.',
									}),
								],
							},
						})
					).pipe(Effect.provide(fixture.publisher))
					expect(fixture.fake.writes.map(write => write.method)).toEqual([
						'reply',
						'unresolve',
						'editReply',
						'review',
						'label',
					])
					const answer = fixture.fake.writes.find(
						write => write.method === 'reply'
					)
					expect(answer?.method).toBe('reply')
					if (answer?.method !== 'reply') return
					expect(answer.body).toContain(
						'This goes to the owner: The disagreement remains.'
					)
					// Posted unsettled; the edit after the reopen drops the flag.
					expect(parseReplyMarker(answer.body)).toEqual({
						v: SUMMARY_MARKER.v,
						action: 'needs-owner',
						commit: fixture.head,
						reply: 42,
						unsettled: true,
					})
					expect(
						JSON.parse(
							/<!-- mng-review:summary (.*) -->$/u.exec(
								reviewBody(fixture.fake) ?? ''
							)?.[1] ?? '{}'
						)
					).toEqual({
						v: SUMMARY_MARKER.v,
						runs: 1,
						finished: true,
						head: fixture.head,
						needsOwner: ['thread'],
					})
				})
		)
		for (const action of ['resolved', 'accepted'] as const)
			test.effect(
				`${action} closes the thread before the verdict even if GitHub refuses resolution`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.threads.push(
							atCommit(
								pendingReviewThread(),
								action === 'resolved' ? fixture.base : fixture.head
							)
						)
						fixture.fake.failures.resolve.push(error(403))
						const decision =
							action === 'accepted'
								? {
										action,
										reason: 'The guard is intentional.',
										memory: 'Keep the guard.',
										evidence: ['src/store.ts:12'],
									}
								: { action, reason: 'The guard fixes it.' }
						const published = yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules: ACCEPTING_RULES,
								replies: {
									tokens: {},
									base: fixture.base,
									decisions: [decidedReply(decision)],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
						expect(published).toMatchObject({
							verdict: 'ready',
							openBugs: 0,
							answered: { [action]: 1 },
						})
						expect(fixture.fake.writes).toContainEqual({
							method: 'resolve',
							id: 'thread',
						})
					})
			)
		test.effect(
			'needs-owner persists its id, labels the pull and names the thread in the summary',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push(pendingReviewThread())
					const published = yield* PublishService.use(service =>
						service.publish({
							...fixture.input,
							replies: {
								tokens: {},
								base: fixture.base,
								decisions: [
									decidedReply({
										action: 'needs-owner',
										reason: 'The premise is disputed again.',
									}),
								],
							},
						})
					).pipe(Effect.provide(fixture.publisher))
					expect(published).toMatchObject({
						verdict: 'needs owner',
						waiting: 1,
						label: 'added',
						answered: { 'needs-owner': 1 },
					})
					expect(
						toCommitStatus(
							published.verdict,
							published.openBugs,
							published.finished
						).state
					).toBe('failure')
					expect(fixture.fake.writes).toContainEqual({
						method: 'label',
						pullNumber: 17,
						name: 'needs-owner',
					})
					const body = reviewBody(fixture.fake) ?? ''
					expect(parseSummaryMarker(body)?.needsOwner).toEqual(['thread'])
					expect(body).toContain('Waiting for the owner (1):')
					expect(body).toContain('thread')
					expect(body).toContain(`- \`src/store.ts:10\` ${bug().title}`)
				})
		)
		for (const [role, allowed, cleared] of [
			['write', false, false],
			['admin', false, true],
			['write', true, true],
			['read', true, false],
		] as const)
			test.effect(
				`a resolver with ${role}, allowed=${allowed} clears=${cleared}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.command.role = role
						fixture.fake.threads.push(
							reviewThread(undefined, {
								isResolved: true,
								resolvedBy: { login: 'contributor' },
							})
						)
						fixture.fake.reviews.push({
							...summary(),
							body: toMarkerComment('summary', {
								...SUMMARY_MARKER,
								head: fixture.head,
								finished: true,
								needsOwner: ['thread'],
							}),
						})
						const rules = {
							...RULES,
							config: {
								...RULES.config,
								commands: {
									...RULES.config.commands,
									allow: allowed ? ['contributor'] : [],
								},
							},
						}
						const published = yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								rules,
								report: { ...fixture.input.report, bugs: [] },
							})
						).pipe(Effect.provide(fixture.publisher))
						expect(published).toMatchObject({
							verdict: cleared ? 'ready' : 'needs owner',
							waiting: cleared ? 0 : 1,
							label: cleared ? 'removed' : 'added',
						})
						expect(
							parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.needsOwner
						).toEqual(cleared ? undefined : ['thread'])
						expect(fixture.fake.writes).toContainEqual({
							method: cleared ? 'unlabel' : 'label',
							pullNumber: 17,
							name: 'needs-owner',
						})
					})
			)
		for (const scenario of [
			'partial',
			'moved-head',
			'identity-switch',
		] as const)
			test.effect(`carries waiting threads across ${scenario}`, () =>
				Effect.gen(function* () {
					const fixture = setup(
						undefined,
						scenario === 'identity-switch'
							? APP_IDENTITY
							: GITHUB_ACTIONS_IDENTITY
					)
					fixture.fake.reviews.push({
						...summary(),
						body: toMarkerComment('summary', {
							...SUMMARY_MARKER,
							head: fixture.head,
							finished: true,
							needsOwner: ['waiting-thread'],
						}),
					})
					if (scenario === 'moved-head')
						fixture.fake.command.pullRequest = {
							...fixture.fake.command.pullRequest,
							head: {
								...fixture.fake.command.pullRequest.head,
								sha: 'c'.repeat(40),
							},
						}
					const published = yield* PublishService.use(service =>
						service.publish({
							...fixture.input,
							report: { ...fixture.input.report, bugs: [] },
							...(scenario === 'identity-switch'
								? {}
								: { command: { agentOnly: scenario === 'partial' } }),
						})
					).pipe(
						Effect.provide(fixture.publisher),
						provideOwnedIdentities(
							scenario === 'identity-switch'
								? APP_IDENTITY
								: GITHUB_ACTIONS_IDENTITY,
							RULES.config.identity.previous
						)
					)
					expect(published).toMatchObject({
						verdict: 'needs owner',
						waiting: 1,
						label: 'added',
					})
					const summaryWrite = fixture.fake.writes.find(
						write =>
							write.method === 'review' || write.method === 'updateReview'
					)
					expect(summaryWrite).toBeDefined()
					if (
						summaryWrite?.method !== 'review' &&
						summaryWrite?.method !== 'updateReview'
					)
						return
					expect(
						parseSummaryMarker(
							summaryWrite.method === 'review'
								? summaryWrite.input.body
								: summaryWrite.body
						)
					).toMatchObject({
						needsOwner: ['waiting-thread'],
						runs: published.run,
					})
				})
			)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService recovered owner state',
	test => {
		for (const scenario of [
			'hidden-summary',
			'recent-answer',
			'outside-window',
			'missing-summary',
			'edited-root',
		] as const)
			for (const resolver of ['writer', 'admin', 'allowed-writer'] as const) {
				const cleared = resolver !== 'writer'
				const expected = {
					verdict: cleared ? 'ready' : 'needs owner',
					waiting: cleared ? 0 : 1,
					label: cleared ? 'removed' : 'added',
				} as const
				const expectedState = cleared ? 'success' : 'failure'
				const expectedIds = cleared ? undefined : ['thread']
				const expectedLabel = cleared ? 'unlabel' : 'label'
				test.effect(
					`${scenario} recovers waiting ids before clearing and writing the next marker: ${resolver}`,
					() =>
						Effect.gen(function* () {
							const fixture = setup()
							fixture.fake.command.role =
								resolver === 'admin' ? 'admin' : 'write'
							const raw =
								scenario === 'hidden-summary' || scenario === 'edited-root'
									? reviewThread()
									: ownerReviewThread(
											scenario === 'outside-window' ? RECENT_COMMENTS + 1 : 1
										)
							fixture.fake.threads.push({
								...raw,
								isResolved: true,
								resolvedBy: { login: 'contributor' },
								...(scenario === 'edited-root'
									? {
											comments: {
												...raw.comments,
												nodes: raw.comments.nodes.map(comment => ({
													...comment,
													editor: { __typename: 'User', login: 'editor' },
												})),
											},
										}
									: {}),
							})
							if (scenario === 'outside-window')
								fixture.fake.threadComments.set('thread', [
									markedThreadReply(),
									...(raw.latest?.nodes ?? []),
								])
							if (scenario !== 'missing-summary')
								fixture.fake.reviews.push({
									...summary(),
									isMinimized: true,
									body: toMarkerComment('summary', {
										...SUMMARY_MARKER,
										head: fixture.head,
										finished: true,
										...(scenario === 'hidden-summary' ||
										scenario === 'edited-root'
											? { needsOwner: ['thread'] }
											: {}),
									}),
								})
							const published = yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									rules: {
										...RULES,
										config: {
											...RULES.config,
											commands: {
												...RULES.config.commands,
												allow:
													resolver === 'allowed-writer' ? ['CONTRIBUTOR'] : [],
											},
										},
									},
									report: { ...fixture.input.report, bugs: [] },
								})
							).pipe(Effect.provide(fixture.publisher))
							expect(published).toMatchObject(expected)
							expect(
								toCommitStatus(
									published.verdict,
									published.openBugs,
									published.finished
								).state
							).toBe(expectedState)
							const written = fixture.fake.writes.findLast(
								write =>
									write.method === 'review' || write.method === 'updateReview'
							)
							expect(written).toBeDefined()
							if (
								written?.method !== 'review' &&
								written?.method !== 'updateReview'
							)
								return
							expect(
								parseSummaryMarker(
									written.method === 'review'
										? written.input.body
										: written.body
								)?.needsOwner
							).toEqual(expectedIds)
							expect(fixture.fake.writes).toContainEqual({
								method: expectedLabel,
								pullNumber: 17,
								name: 'needs-owner',
							})
							expect(
								fixture.fake.reads.filter(read =>
									read.startsWith('listThreadComments:')
								)
							).toEqual(
								// The owner read, the settle read, the bug count's read and, for an owner's
								// resolution, the clearing read.
								scenario === 'outside-window'
									? Array.from(
											{ length: cleared ? 4 : 3 },
											() => 'listThreadComments:thread'
										)
									: []
							)
						})
				)
			}
		test.effect(
			'a failed summary write after needs-owner is recovered on the next publish and sweep',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.command.role = 'write'
					fixture.fake.threads.push(pendingReviewThread())
					fixture.fake.reviews.push({
						...summary(),
						state: 'CHANGES_REQUESTED',
						commit: { oid: fixture.head },
					})
					fixture.fake.failures.updateReview.push(error(503))
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(
						yield* publisher
							.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [] },
								replies: {
									tokens: {},
									base: fixture.base,
									decisions: [
										decidedReply({
											action: 'needs-owner',
											reason: 'Owner required.',
										}),
									],
								},
							})
							.pipe(Effect.flip)
					).toBeInstanceOf(PublishIncompleteError)
					expect(
						parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.needsOwner
					).toBeUndefined()
					expect(
						fixture.fake.writes.filter(write => write.method === 'reply')
					).toHaveLength(1)
					fixture.fake.threads.splice(0, 1, {
						...(fixture.fake.threads[0] ?? pendingReviewThread()),
						isResolved: true,
						resolvedBy: { login: 'contributor' },
					})
					const statuses = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, fixture.head)]),
						getStatus: () =>
							Effect.succeed({
								id: 1,
								state: 'failure',
								description: 'stale',
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
					).toEqual({
						checked: 1,
						updated: 1,
						failed: 0,
						dismissal: NO_DISMISSAL,
					})
					expect(statuses.statuses.at(-1)?.state).toBe('failure')
					expect(
						yield* publisher.publish({
							...fixture.input,
							report: { ...fixture.input.report, bugs: [] },
						})
					).toMatchObject({
						verdict: 'needs owner',
						waiting: 1,
						label: 'added',
						answered: {},
					})
					expect(
						parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.needsOwner
					).toEqual(['thread'])
					expect(
						fixture.fake.writes.filter(write => write.method === 'reply')
					).toHaveLength(1)
				})
		)
		test.effect(
			'a failed whole-thread read holds the longer threads for the run only and preserves the hidden summary list',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.command.role = 'write'
					fixture.fake.threads.push(
						ownerReviewThread(1, { id: 'recent', isResolved: true }),
						ownerReviewThread(RECENT_COMMENTS + 1, {
							id: 'long',
							isResolved: true,
						})
					)
					fixture.fake.reviews.push({
						...summary(),
						isMinimized: true,
						body: toMarkerComment('summary', {
							...SUMMARY_MARKER,
							needsOwner: ['hidden'],
						}),
					})
					fixture.fake.failures.listThreadComments.push(error(503))
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [] },
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						verdict: 'needs owner',
						waiting: 3,
						label: 'added',
					})
					const written = fixture.fake.writes.findLast(
						write =>
							write.method === 'review' || write.method === 'updateReview'
					)
					expect(written).toBeDefined()
					if (
						written?.method !== 'review' &&
						written?.method !== 'updateReview'
					)
						return
					expect(
						parseSummaryMarker(
							written.method === 'review' ? written.input.body : written.body
						)?.needsOwner
					).toEqual(['hidden', 'recent'])
					expect(
						fixture.fake.reads.filter(read =>
							read.startsWith('listThreadComments:')
						)
					).toEqual(Array.from({ length: 3 }, () => 'listThreadComments:long'))
				})
		)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService edited waiting threads',
	test => {
		for (const listed of [false, true])
			for (const resolver of ['writer', 'admin', 'allowed-writer'] as const)
				test.effect(
					`an edited root resolved by ${resolver} ${listed ? 'with' : 'without'} a summary waiting id only clears for an owner`,
					() =>
						Effect.gen(function* () {
							const fixture = setup()
							const cleared = resolver !== 'writer'
							fixture.fake.command.role =
								resolver === 'admin' ? 'admin' : 'write'
							fixture.fake.threads.push(
								editedOwnerReviewThread(1, {
									isResolved: true,
									resolvedBy: { login: 'contributor' },
								})
							)
							fixture.fake.reviews.push({
								...summary(),
								body: toMarkerComment('summary', {
									...SUMMARY_MARKER,
									head: fixture.head,
									finished: true,
									...(listed ? { needsOwner: ['thread'] } : {}),
								}),
							})
							const published = yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									report: { ...fixture.input.report, bugs: [] },
									rules: {
										...RULES,
										config: {
											...RULES.config,
											commands: {
												...RULES.config.commands,
												allow:
													resolver === 'allowed-writer' ? ['CONTRIBUTOR'] : [],
											},
										},
									},
								})
							).pipe(Effect.provide(fixture.publisher))
							expect(published).toMatchObject({
								verdict: cleared ? 'ready' : 'needs owner',
								waiting: cleared ? 0 : 1,
								label: cleared ? 'removed' : 'added',
							})
							expect(
								parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.needsOwner
							).toEqual(cleared ? undefined : ['thread'])
							expect(fixture.fake.writes).toContainEqual({
								method: cleared ? 'unlabel' : 'label',
								pullNumber: 17,
								name: 'needs-owner',
							})
							expect(
								fixture.fake.writes.filter(write => write.method === 'reply')
							).toEqual([])
						})
				)
		test.effect(
			'an edited root recovers its waiting id from an answer outside the latest comments without a summary waiting id',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.command.role = 'write'
					const raw = editedOwnerReviewThread(RECENT_COMMENTS, {
						isResolved: true,
						resolvedBy: { login: 'contributor' },
					})
					fixture.fake.threads.push(raw)
					fixture.fake.threadComments.set('thread', [
						markedThreadReply(),
						...(raw.latest?.nodes ?? []),
					])
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [] },
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						verdict: 'needs owner',
						waiting: 1,
						label: 'added',
					})
					expect(
						parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.needsOwner
					).toEqual(['thread'])
					expect(
						fixture.fake.reads.filter(read =>
							read.startsWith('listThreadComments:')
						)
					).toEqual(['listThreadComments:thread', 'listThreadComments:thread'])
				})
		)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService needs-owner git boundary',
	test => {
		for (const scenario of [
			'git-protected-in-place',
			'git-protected-rename',
			'forged-protected-rename',
		] as const)
			test.effect(
				`first-reply needs-owner follows git rather than the outcome rename: ${scenario}`,
				() =>
					Effect.gen(function* () {
						const renamedFrom =
							scenario === 'git-protected-rename'
								? 'src/protected.ts'
								: undefined
						const fixture = setup(
							undefined,
							GITHUB_ACTIONS_IDENTITY,
							renamedFrom
						)
						const stands = scenario !== 'forged-protected-rename'
						const riskPath =
							scenario === 'git-protected-in-place'
								? bug().path
								: 'src/protected.ts'
						fixture.fake.command.role = 'write'
						fixture.fake.threads.push(pendingReviewThread())
						const forgedChange = {
							...fixture.input.report.planReport.change,
							files: fixture.input.report.planReport.change.files.map(
								changed => ({
									...changed,
									status:
										scenario === 'git-protected-rename'
											? ('modified' as const)
											: ('renamed' as const),
									...(scenario === 'git-protected-rename'
										? {}
										: {
												oldPath:
													scenario === 'git-protected-in-place'
														? 'docs/store.ts'
														: riskPath,
											}),
								})
							),
						}
						const published = yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								report: {
									...fixture.input.report,
									bugs: [],
									planReport: {
										...fixture.input.report.planReport,
										change: forgedChange,
									},
								},
								rules: {
									...ACCEPTING_RULES,
									config: { ...ACCEPTING_RULES.config, risk_paths: [riskPath] },
								},
								replies: {
									base: fixture.base,
									tokens: {},
									decisions: [
										decidedReply({
											action: 'needs-owner',
											reason: 'Owner required.',
										}),
									],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
						expect(published).toMatchObject({
							verdict: stands ? 'needs owner' : 'needs fixes',
							waiting: stands ? 1 : 0,
							answered: stands ? { 'needs-owner': 1 } : {},
						})
						expect(
							fixture.fake.writes.filter(write => write.method === 'reply')
						).toHaveLength(stands ? 1 : 0)
						expect(
							parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.needsOwner
						).toEqual(stands ? ['thread'] : undefined)
						// One read either way: the check before the answer, or the rounds when the limit fails.
						expect(
							fixture.fake.reads.filter(read =>
								read.startsWith('listThreadComments:')
							)
						).toEqual(['listThreadComments:thread'])
					})
			)
		for (const rounds of ['first-reply', 'max-rounds'] as const)
			test.effect(
				`a missing git base drops needs-owner unless owned disputes reach max_rounds: ${rounds}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const stands = rounds === 'max-rounds'
						fixture.fake.command.role = 'write'
						fixture.fake.threads.push(pendingReviewThread())
						fixture.fake.threadComments.set('thread', [
							...Array.from(
								{ length: stands ? RULES.config.disputes.max_rounds : 0 },
								(_, index) =>
									markedThreadReply('disputed', { databaseId: 100 + index })
							),
							...(pendingReviewThread().latest?.nodes ?? []),
						])
						const published = yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [] },
								rules: {
									...RULES,
									config: { ...RULES.config, risk_paths: [bug().path] },
								},
								replies: {
									base: '0'.repeat(40),
									tokens: {},
									decisions: [
										decidedReply({
											action: 'needs-owner',
											reason: 'Owner required.',
										}),
									],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
						expect(published).toMatchObject({
							verdict: stands ? 'needs owner' : 'needs fixes',
							waiting: stands ? 1 : 0,
							answered: stands ? { 'needs-owner': 1 } : {},
						})
						expect(
							fixture.fake.writes.filter(write => write.method === 'reply')
						).toHaveLength(stands ? 1 : 0)
						expect(
							parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.needsOwner
						).toEqual(stands ? ['thread'] : undefined)
						expect(
							fixture.fake.reads.filter(read =>
								read.startsWith('listThreadComments:')
							)
						).toEqual([
							'listThreadComments:thread',
							...(stands ? ['listThreadComments:thread'] : []),
						])
					})
			)
	}
)

/** A confirmed bug whose outcome-file edit names `line` and claims `original` there. */
function editedBug(head: string, line: number, original: string) {
	return bug({
		line,
		suggestion: 'Write once.',
		validation: {
			status: 'confirmed',
			severity: 'high',
			reason: 'Confirmed.',
			evidence: [],
			model: 'model',
			edit: { commit: head, line, original, replacement: 'fixed 10' },
		},
	})
}

/** The posted inline comment's body for one bug, with publishing reading git through `git`. */
const postedBody = (
	fixture: ReturnType<typeof setup>,
	finding: ReturnType<typeof bug>,
	git: GitService['Service']
) =>
	Effect.gen(function* () {
		const publisher = yield* PublishService.pipe(
			Effect.provide(
				PublishServiceLive.pipe(
					Layer.provide(SummaryReviewServiceLive),
					Layer.provide(
						Layer.merge(fixture.dependencies, Layer.succeed(GitService, git))
					)
				)
			)
		)
		yield* publisher.publish({
			...fixture.input,
			report: { ...fixture.input.report, bugs: [finding] },
		})
		const review = fixture.fake.writes.find(call => call.method === 'review')
		expect(review?.input.comments).toHaveLength(1)
		const body = review?.input.comments[0]?.body ?? ''
		expect(parseFindingMarker(body)?.fingerprint).toBe(finding.fingerprint)
		expect(body).toContain('**Fix:** Write once.')
		return body
	})

const SUGGESTION = /`{3,}suggestion\n/u

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishServiceLive suggested edits',
	test => {
		test.effect(
			'suggests an edit whose original text is the head line git reads',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const git = yield* GitService.pipe(
						Effect.provide(gitLayer(fixture.repo.root))
					)
					const readFileAtSpy = vi.spyOn(git, 'readFileAt')
					expect(
						yield* postedBody(
							fixture,
							editedBug(fixture.head, 10, 'changed 10'),
							git
						)
					).toMatch(SUGGESTION)
					expect(readFileAtSpy).toHaveBeenCalledWith(fixture.head, bug().path)
				})
		)
		for (const [scenario, line, original] of [
			['a finding moved to another line', 11, 'changed 10'],
			['a wrong original text', 10, 'line 10'],
			['an original with trailing whitespace', 10, 'changed 10 '],
		] as const)
			test.effect(
				`posts no suggestion for a hostile outcome with ${scenario}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const git = yield* GitService.pipe(
							Effect.provide(gitLayer(fixture.repo.root))
						)
						expect(
							yield* postedBody(
								fixture,
								editedBug(fixture.head, line, original),
								git
							)
						).not.toMatch(SUGGESTION)
					})
			)
		test.effect('posts no suggestion when the head read fails', () =>
			Effect.gen(function* () {
				const fixture = setup()
				const git = yield* GitService.pipe(
					Effect.provide(gitLayer(fixture.repo.root))
				)
				const readFileAtSpy = vi
					.spyOn(git, 'readFileAt')
					.mockReturnValue(
						Effect.fail(
							new GitError({ args: ['show'], exitCode: 128, stderr: 'gone' })
						)
					)
				expect(
					yield* postedBody(
						fixture,
						editedBug(fixture.head, 10, 'changed 10'),
						git
					)
				).not.toMatch(SUGGESTION)
				expect(readFileAtSpy).toHaveBeenCalled()
			})
		)
	}
)

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService command answer markers',
	test => {
		for (const kind of ['review', 'run'] as const)
			test.effect(
				`a ${kind} review publishes its answered commands in the summary marker`,
				() =>
					Effect.gen(function* () {
						const fixture = setup(undefined, APP_IDENTITY)
						const answers = [
							{
								run: 7,
								kind,
								...(kind === 'run' ? { agent: 'auth' } : {}),
								ids: [
									{
										id: 42,
										at: '2026-01-01T12:00:00Z',
										digest: 'a'.repeat(16),
									},
								],
							},
						] as const
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								answers,
								...(kind === 'review'
									? {
											rating: {
												status: 'rated',
												level: 'low',
												floors: [],
												reasons: [],
												reused: false,
											} as const,
										}
									: { command: { agentOnly: true, agent: 'auth' } }),
							})
						).pipe(Effect.provide(fixture.publisher))
						expect(
							parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.answers
						).toEqual(answers)
						if (kind === 'review')
							expect(
								parseSummaryMarker(reviewBody(fixture.fake) ?? '')?.risk
							).toBe('low')
					})
			)
		test.effect(
			'a run whose head moved and posts nothing still records its answers, not its rating',
			() =>
				Effect.gen(function* () {
					const fixture = setup(undefined, APP_IDENTITY)
					const prior = {
						...SUMMARY_MARKER,
						head: 'new-full-review-head',
						finished: true,
						answers: reviewAnswers(1),
					}
					fixture.fake.reviews.push(
						summaryReview(prior, {
							author: { __typename: 'Bot', login: APP_IDENTITY.login },
						})
					)
					fixture.fake.command.pullRequest = {
						...fixture.fake.command.pullRequest,
						head: {
							...fixture.fake.command.pullRequest.head,
							sha: 'moved-head',
						},
					}
					const answers = reviewAnswers(1, 2)
					yield* PublishService.use(service =>
						service.publish({
							...fixture.input,
							command: { agentOnly: false },
							report: { ...fixture.input.report, bugs: [] },
							answers,
							rating: {
								status: 'rated',
								level: 'low',
								floors: [],
								reasons: [],
								reused: false,
							},
						})
					).pipe(Effect.provide(fixture.publisher))
					const marker = parseSummaryMarker(reviewBody(fixture.fake) ?? '')
					expect(marker?.answers).toEqual([...prior.answers, ...answers])
					expect(marker?.risk).toBeUndefined()
				})
		)
		test.effect(
			'an answer past the cap fails the publish and leaves the summary as it was',
			() =>
				Effect.gen(function* () {
					const fixture = setup(undefined, APP_IDENTITY)
					const existing = summaryReview(
						{ ...SUMMARY_MARKER, answers: reviewAnswers(MAX_ANSWER_ENTRIES) },
						{ author: { __typename: 'Bot', login: APP_IDENTITY.login } }
					)
					fixture.fake.reviews.push(existing)
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								answers: reviewAnswers(1, MAX_ANSWER_ENTRIES + 1),
							})
						).pipe(Effect.provide(fixture.publisher), Effect.flip)
					).toMatchObject({
						_tag: 'PublishIncompleteError',
						error: {
							_tag: 'SummaryMarkerError',
							answers: MAX_ANSWER_ENTRIES + 1,
						},
					})
					expect(fixture.fake.reviews).toEqual([existing])
				})
		)
	}
)

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'published rating block marker',
	test => {
		for (const status of ['rated', 'unrated', 'absent'] as const)
			test.effect(
				`a ${status} block has the matching summary marker risk`,
				() =>
					Effect.gen(function* () {
						const fixture = setup(undefined, APP_IDENTITY)
						const rating =
							status === 'absent'
								? undefined
								: status === 'rated'
									? ({
											status: 'rated',
											level: 'medium',
											floors: [],
											reasons: ['A local change.'],
											reused: false,
										} as const)
									: ({
											status: 'unrated',
											reason: 'coverage-gap',
											detail: 'missing range',
											floors: [],
										} as const)
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								...(rating ? { rating } : {}),
							})
						).pipe(Effect.provide(fixture.publisher))
						const body = fixture.fake.reviews.at(-1)?.body ?? ''
						expect(parseSummaryMarker(body)?.risk).toBe(
							status === 'rated' ? 'medium' : undefined
						)
						if (status === 'rated') expect(body).toContain('**Risk: medium**')
						if (status === 'unrated')
							expect(body).toContain('**Risk: not rated**')
					})
			)
	}
)

/** The fixture's publish input with no bug of its own, so only the threads count. */
function withoutBugs(input: ReturnType<typeof setup>['input']) {
	return { ...input, report: { ...input.report, bugs: [] } }
}

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService unsettled bug threads',
	test => {
		for (const place of ['window', 'outside'] as const)
			test.effect(
				`counts a resolved bug whose unsettled answer is ${place} its window as open`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const { thread, comments } = unsettledBugThread(place)
						fixture.fake.threads.push(thread)
						fixture.fake.threadComments.set(thread.id, [...comments])
						fixture.fake.failures.unresolve.push(error(503))
						expect(
							yield* PublishService.use(service =>
								service.publish(withoutBugs(fixture.input))
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({ openBugs: 1, unsettled: 1 })
					})
			)
		test.effect(
			'counts a resolved bug as open when its whole thread cannot be read',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const { thread } = unsettledBugThread('outside')
					fixture.fake.threads.push(thread)
					fixture.fake.failures.listThreadComments.push(
						error(503),
						error(503),
						error(503),
						error(503)
					)
					expect(
						yield* PublishService.use(service =>
							service.publish(withoutBugs(fixture.input))
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ openBugs: 1 })
				})
		)
		test.effect(
			'counts a resolved bug as open when GitHub lists its unsettled answer as a null node',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const { thread, comments } = unsettledBugThread('outside')
					fixture.fake.threads.push(thread)
					fixture.fake.threadReader.read = readThreadOverHttp(
						comments.map(comment =>
							parseReplyMarker(comment.body)?.unsettled ? null : comment
						)
					)
					expect(
						yield* PublishService.use(service =>
							service.publish(withoutBugs(fixture.input))
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ openBugs: 1 })
				})
		)
	}
)
