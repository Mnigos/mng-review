import { layer } from '@effect/vitest'
import { Clock, ConfigProvider, Duration, Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import type {
	CommitStatus,
	OpenPullRequest,
	PullRequestReview,
} from '../../../platform/github-api.schema'
import type { GitHubStatusService } from '../../../platform/github-status.service'
import { GitHubReadConfigLive } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { provideListCompleteness } from '../../../platform/list-completeness.context'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	githubStatusFake,
	openPullRequest,
} from '../../../shared/mocks/github-status-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	bug,
	reviewThread,
	SUMMARY_MARKER,
	summaryReview,
} from '../../../shared/mocks/publish-test.helper'
import { pendingReviewThread } from '../../../shared/mocks/thread-reply-test.helper'
import {
	ReplyFindService,
	ReplyFindServiceLive,
} from '../../publish/application/reply-find.service'
import { SummaryReviewServiceLive } from '../../publish/application/summary-review.service'
import type { SummaryMarker } from '../../publish/domain/publish-marker.schema'
import { toClearedMessage } from '../../publish/presentation/summary-status.formatter'
import {
	type CommitStatusText,
	toCommitStatus,
	UNFINISHED_NOTE,
} from '../domain/status.helper'
import { RaiseService, RaiseServiceLive } from './raise.service'
import type { RaiseScan } from './raise.service.types'
import {
	StatusSweepService,
	StatusSweepServiceLive,
} from './status-sweep.service'

/** The current identity as the fake lists its reviews. */
const APP_AUTHOR = { __typename: 'Bot', login: APP_IDENTITY.login } as const
/** The read token's settings the reply search reads the summaries with. */
const READ_CONFIG = GitHubReadConfigLive.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromEnvRecord({
				GITHUB_REPOSITORY: 'example/project',
				GITHUB_TOKEN: 'fixture',
			})
		)
	)
)

/** A summary marker on `head`, the head every fixture pull request is on unless a test moves it. */
const ON_HEAD = { ...SUMMARY_MARKER, head: 'head' } as const
/** A full commit SHA, which the reply search needs to list a pull request. */
const FULL_HEAD = 'c'.repeat(40)

/** The fake's change request of the current identity, carrying `marker` as its summary. */
function changeRequest(
	overrides: Partial<PullRequestReview> = {},
	marker: SummaryMarker = ON_HEAD
) {
	return summaryReview(marker, {
		id: 'current-request',
		databaseId: 102,
		state: 'CHANGES_REQUESTED',
		commit: marker.head === undefined ? null : { oid: marker.head },
		author: APP_AUTHOR,
		...overrides,
	})
}

/** When GitHub says a status the test wrote was written: after every time the specs seed but one. */
const WRITTEN_AT = '2026-11-20T10:02:00Z'

/** A status the head has before the raise, with when GitHub says it was written. */
type SeededStatus = CommitStatusText & Pick<CommitStatus, 'created_at'>

/** The bot's `failure` for the one bug thread a person since resolved by hand. */
const ONE_BUG = toCommitStatus('needs fixes', 1, true)
/** The `success` a raise writes once nothing blocks. */
const READY = toCommitStatus('ready', 0, true)

/**
 * Pull request 17 on `head`: a finished summary of the app on the head, the app's change request,
 * one bug thread a person resolved by hand and the bot's `previous` status (`failure`, or `null` for none), so
 * a raise is due. The head shows the newest status written, `previous` before any.
 */
function raiseSetup(
	pulls: readonly OpenPullRequest[] = [openPullRequest(17, 'head')],
	head = 'head',
	previous: SeededStatus | null = ONE_BUG,
	allow: readonly string[] = [],
	setStatus?: GitHubStatusService['Service']['setStatus'],
	readDelay?: Duration.Input,
	hangAt?: number
) {
	const statusReads = { count: 0 }
	const api = githubApiFake(APP_IDENTITY)
	api.command.pullRequest = {
		...api.command.pullRequest,
		head: { ...api.command.pullRequest.head, sha: head },
	}
	const marker = { ...SUMMARY_MARKER, head }
	api.reviews.push(
		summaryReview(
			{ ...marker, finished: true },
			{ databaseId: 101, author: APP_AUTHOR }
		),
		changeRequest({}, marker)
	)
	api.threads.push(reviewThread(undefined, { isResolved: true }))
	const status = githubStatusFake({
		...(setStatus ? { setStatus } : {}),
		listOpenPullRequests: () => Effect.succeed(pulls),
		getStatus: () => {
			statusReads.count += 1
			// A read that never ends, for a judgment the scan's hard bound must drop.
			if (statusReads.count === hangAt) return Effect.never
			const written = status.statuses.at(-1)
			const newest = written
				? { created_at: WRITTEN_AT, ...written }
				: (previous ?? undefined)
			const read = Effect.succeed(
				newest && {
					id: status.statuses.length + 1,
					...newest,
					context: 'MNG Review',
					creator: null,
				}
			)
			// A slow read, so a scan on the test clock runs into its deadline.
			return readDelay === undefined
				? read
				: Effect.sleep(readDelay).pipe(Effect.andThen(read))
		},
	})
	const services = Layer.mergeAll(
		RaiseServiceLive,
		StatusSweepServiceLive,
		ReplyFindServiceLive.pipe(Layer.provide(SummaryReviewServiceLive))
	).pipe(Layer.provide(Layer.mergeAll(api.api, status.layer, READ_CONFIG)))
	const findDue = RaiseService.use(service => service.findDue(allow)).pipe(
		Effect.provide(services)
	)
	const findDueWith = (scan: RaiseScan) =>
		RaiseService.use(service => service.findDue(allow, scan)).pipe(
			Effect.provide(services)
		)
	const raise = RaiseService.use(service => service.raise(17, allow)).pipe(
		Effect.provide(services)
	)
	const sweep = StatusSweepService.use(service => service.sweep(allow)).pipe(
		Effect.provide(services)
	)
	const findReplies = ReplyFindService.use(service =>
		service.find({ max: 5, rotation: 0 })
	).pipe(Effect.provide(services))
	const dismissed = () =>
		api.writes.flatMap(write =>
			write.method === 'dismissReview' ? [write.id] : []
		)
	return {
		api,
		status,
		findDue,
		findDueWith,
		raise,
		sweep,
		findReplies,
		dismissed,
	}
}

layer(APP_MODE_OWNED)('RaiseService schedule run', test => {
	test.effect(
		'the last thread resolved by hand turns the status green and lifts the change request in one schedule run, both in the locked job',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				// One run of the schedule file: the sweep, then the reply schedule's find and locked job.
				// The sweep only lowers, so it leaves the `failure` to the locked job.
				expect(yield* fixture.sweep).toEqual({
					checked: 1,
					updated: 0,
					failed: 0,
				})
				expect(fixture.status.statuses).toEqual([])
				expect((yield* fixture.findReplies).candidates).toEqual([])
				expect(yield* fixture.findDue).toEqual({
					pulls: [17],
					read: 1,
					failed: 0,
					unscanned: 0,
					deferred: 0,
				})
				expect(yield* fixture.raise).toEqual({
					outcome: 'raised',
					head: 'head',
					status: READY,
					dismissal: { dismissed: 1, failed: 0 },
				})
				expect(fixture.status.statuses).toEqual([{ sha: 'head', ...READY }])
				expect(
					fixture.api.reviews.filter(
						review => review.state === 'CHANGES_REQUESTED'
					)
				).toEqual([])
				expect(
					fixture.api.writes.filter(write => write.method === 'dismissReview')
				).toEqual([
					{ method: 'dismissReview', id: 102, body: toClearedMessage('head') },
				])
			})
	)
	test.effect(
		'a pull request with a reply and a due raise is listed once on each side, and a second raise writes nothing',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup([openPullRequest(17, FULL_HEAD)], FULL_HEAD)
				fixture.api.command.role = 'write'
				// A person's reply waits in an unverified thread, which backs no change request.
				fixture.api.threads.push(
					pendingReviewThread({
						...reviewThread({ finding: bug(), kind: 'unverified' }),
						id: 'unverified-thread',
						comments: {
							...reviewThread({ finding: bug(), kind: 'unverified' }).comments,
							totalCount: 2,
						},
					})
				)
				const replies = yield* fixture.findReplies
				expect(replies.candidates.map(pull => pull.number)).toEqual([17])
				expect((yield* fixture.findDue).pulls).toEqual([17])
				// The workflow runs the raise entry after the reply's publish leg; a repeat finds nothing left.
				expect((yield* fixture.raise).outcome).toBe('raised')
				expect((yield* fixture.raise).outcome).toBe('not-due')
				expect(fixture.dismissed()).toEqual([102])
				expect(fixture.status.statuses).toEqual([{ sha: FULL_HEAD, ...READY }])
			})
	)
})

layer(APP_MODE_OWNED)('RaiseService incomplete reads', test => {
	for (const list of ['threads', 'comments', 'reviews'] as const)
		test.effect(`a null node in the ${list} lists nothing in find`, () =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				fixture.api.nullNodes[list] = 1
				expect(
					yield* fixture.findDue.pipe(provideListCompleteness(false))
				).toEqual({ pulls: [], read: 1, failed: 0, unscanned: 0, deferred: 0 })
				fixture.api.nullNodes[list] = 0
				expect(
					(yield* fixture.findDue.pipe(provideListCompleteness(false))).pulls
				).toEqual([17])
				expect(fixture.dismissed()).toEqual([])
			})
		)
	test.effect(
		'a null node in the locked job dismisses nothing, though find listed the pull request',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				expect(
					(yield* fixture.findDue.pipe(provideListCompleteness(false))).pulls
				).toEqual([17])
				fixture.api.nullNodes.threads = 1
				expect(
					yield* fixture.raise.pipe(provideListCompleteness(false))
				).toEqual({
					outcome: 'incomplete',
					head: 'head',
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.dismissed()).toEqual([])
				expect(fixture.status.statuses).toEqual([])
				expect(fixture.api.reviews[1]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'a null node on one pull request leaves the next one free to be listed',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup([
					openPullRequest(17, 'head'),
					openPullRequest(18, 'head'),
				])
				// Only the first pull request's thread read lists a null node.
				fixture.api.nullNodes.queued.threads.push(1, 0)
				expect(
					yield* fixture.findDue.pipe(provideListCompleteness(false))
				).toEqual({
					pulls: [18],
					read: 2,
					failed: 0,
					unscanned: 0,
					deferred: 0,
				})
			})
	)
})

layer(APP_MODE_OWNED)('RaiseService under the lock', test => {
	test.effect('a bug reopened after find keeps the change request', () =>
		Effect.gen(function* () {
			const fixture = raiseSetup()
			expect((yield* fixture.findDue).pulls).toEqual([17])
			// A reply run reopens the bug thread before the raise job gets the group.
			fixture.api.threads.splice(0, 1, reviewThread())
			expect(yield* fixture.raise).toEqual({
				outcome: 'not-due',
				head: 'head',
				dismissal: { dismissed: 0, failed: 0 },
			})
			expect(fixture.dismissed()).toEqual([])
		})
	)
	test.effect('a wait recorded after find keeps the change request', () =>
		Effect.gen(function* () {
			const fixture = raiseSetup()
			expect((yield* fixture.findDue).pulls).toEqual([17])
			// A reply run sends the resolved thread to the owner and records it in a newer summary.
			fixture.api.reviews.push(
				summaryReview(
					{
						...SUMMARY_MARKER,
						head: 'head',
						finished: true,
						needsOwner: ['thread'],
					},
					{ id: 'waiting-103', databaseId: 103, author: APP_AUTHOR }
				)
			)
			// The status only says what blocks now; the change request stays.
			expect(yield* fixture.raise).toMatchObject({
				outcome: 'updated',
				status: toCommitStatus('needs owner', 0, true),
			})
			expect(fixture.dismissed()).toEqual([])
		})
	)
	test.effect(
		'an unfinished summary an incomplete write left keeps the change request',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				fixture.api.reviews.push(
					summaryReview(
						{ ...SUMMARY_MARKER, head: 'head', finished: false, failed: true },
						{ id: 'unfinished-103', databaseId: 103, author: APP_AUTHOR }
					)
				)
				expect((yield* fixture.findDue).pulls).toEqual([])
				expect((yield* fixture.raise).outcome).toBe('not-due')
				expect(fixture.dismissed()).toEqual([])
			})
	)
	test.effect(
		'a change request posted while the raise read the threads is never dismissed',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				const later = changeRequest({ id: 'later-request', databaseId: 104 })
				// The new request lands after the review read, while the threads are read.
				fixture.api.threadSnapshots.shift = () => {
					fixture.api.reviews.push(later)
					return undefined
				}
				expect((yield* fixture.raise).dismissal).toEqual({
					dismissed: 1,
					failed: 0,
				})
				expect(fixture.dismissed()).toEqual([102])
				expect(fixture.api.reviews.at(-1)?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'a head that moved before the dismissal keeps every request',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				const { pullRequest } = fixture.api.command
				fixture.api.pullRequestSnapshots.push(pullRequest, {
					...pullRequest,
					head: { ...pullRequest.head, sha: 'next-head' },
				})
				expect(yield* fixture.raise).toEqual({
					outcome: 'moved',
					head: 'head',
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.dismissed()).toEqual([])
			})
	)
	test.effect('a closed pull request is left alone', () =>
		Effect.gen(function* () {
			const fixture = raiseSetup()
			fixture.api.command.pullRequest = {
				...fixture.api.command.pullRequest,
				state: 'closed',
			}
			expect(yield* fixture.raise).toEqual({
				outcome: 'closed',
				dismissal: { dismissed: 0, failed: 0 },
			})
			expect(fixture.api.reads).toEqual(['getPullRequest:17'])
			expect(fixture.dismissed()).toEqual([])
		})
	)
	test.effect('a failed read fails the raise and writes nothing', () =>
		Effect.gen(function* () {
			const fixture = raiseSetup()
			fixture.api.failures.listThreads.push(
				new GitHubApiError({
					operation: 'listReviewThreads',
					reason: 'Unavailable',
					status: 503,
				})
			)
			expect(yield* Effect.flip(fixture.raise)).toMatchObject({
				_tag: 'GitHubApiError',
				operation: 'listReviewThreads',
			})
			expect(fixture.dismissed()).toEqual([])
		})
	)
	for (const denied of [false, true])
		test.effect(
			`only the current identity's change requests are lifted, dismissal denied=${denied}`,
			() =>
				Effect.gen(function* () {
					const fixture = raiseSetup()
					fixture.api.reviews.push(
						changeRequest({
							id: 'previous-request',
							databaseId: 103,
							author: { __typename: 'Bot', login: 'github-actions' },
						}),
						changeRequest({
							id: 'current-approval',
							databaseId: 104,
							state: 'APPROVED',
						})
					)
					if (denied)
						fixture.api.failures.dismissReview.push(
							new GitHubApiError({
								operation: 'dismissReview',
								reason: 'Denied',
								status: 403,
							})
						)
					expect((yield* fixture.raise).dismissal).toEqual(
						denied ? { dismissed: 0, failed: 1 } : { dismissed: 1, failed: 0 }
					)
					expect(fixture.dismissed()).toEqual([102])
					expect(fixture.api.reviews[2]?.state).toBe('CHANGES_REQUESTED')
					expect(fixture.api.reviews[3]?.state).toBe('APPROVED')
				})
		)
	for (const open of [false, true])
		test.effect(
			`a marker on another head with open=${open} lifts only change requests on a known commit off the head`,
			() =>
				Effect.gen(function* () {
					const fixture = raiseSetup()
					// An unfinished full run left the marker on the older head.
					const marker = {
						...SUMMARY_MARKER,
						head: 'older-head',
						finished: false,
					}
					fixture.api.reviews.splice(
						0,
						fixture.api.reviews.length,
						summaryReview(marker, { databaseId: 101, author: APP_AUTHOR }),
						changeRequest({ id: 'older-request', databaseId: 102 }, marker),
						changeRequest(
							{
								id: 'head-request',
								databaseId: 103,
								commit: { oid: 'head' },
							},
							marker
						),
						changeRequest(
							{ id: 'lost-commit-request', databaseId: 104, commit: null },
							marker
						)
					)
					if (open) fixture.api.threads.splice(0, 1, reviewThread())
					// The open bug only refreshes the failure; the change requests stay.
					expect((yield* fixture.raise).outcome).toBe(
						open ? 'updated' : 'raised'
					)
					expect(fixture.dismissed()).toEqual(open ? [] : [102])
				})
		)
	for (const unthreadedBugs of [1, 0])
		test.effect(
			`a marker on an older head with unthreaded bugs=${unthreadedBugs} ${unthreadedBugs > 0 ? 'backs its change request after a push' : 'lets the off-head change request go'}`,
			() =>
				Effect.gen(function* () {
					// A full run on the older head left a bug without a thread and its change request; the
					// author pushed, and the new head has no status and no review yet.
					const fixture = raiseSetup()
					const marker = {
						...SUMMARY_MARKER,
						head: 'older-head',
						finished: true,
						unthreadedBugs,
					}
					fixture.api.reviews.splice(
						0,
						fixture.api.reviews.length,
						summaryReview(marker, { databaseId: 101, author: APP_AUTHOR }),
						changeRequest({ id: 'older-request', databaseId: 102 }, marker)
					)
					expect((yield* fixture.findDue).pulls).toEqual([17])
					// The new head never had a full run: its `failure` becomes `error` either way, and only
					// a marker with no bug without a thread lets the change request go.
					expect((yield* fixture.raise).outcome).toBe(
						unthreadedBugs > 0 ? 'updated' : 'raised'
					)
					expect(fixture.dismissed()).toEqual(unthreadedBugs > 0 ? [] : [102])
					expect(fixture.status.statuses).toEqual([
						{ sha: 'head', ...toCommitStatus('ready', 0, false) },
					])
				})
		)
})

layer(APP_MODE_OWNED)('RaiseService find', test => {
	test.effect(
		'a green pull request with no change request of the current identity reads nothing past its reviews',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(undefined, undefined, READY)
				fixture.api.reviews.splice(1, 1)
				expect(yield* fixture.findDue).toEqual({
					pulls: [],
					read: 1,
					failed: 0,
					unscanned: 0,
					deferred: 0,
				})
				expect(fixture.api.threadReads).toEqual([])
				expect(fixture.api.commentReads).toEqual([])
			})
	)
	test.effect(
		'a read that fails on one pull request is counted and the next one is listed',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup([
					openPullRequest(17, 'head'),
					openPullRequest(18, 'head'),
				])
				fixture.api.failures.listThreads.push(
					new GitHubApiError({
						operation: 'listReviewThreads',
						reason: 'Unavailable',
						status: 503,
					})
				)
				expect(yield* fixture.findDue).toEqual({
					pulls: [18],
					read: 2,
					failed: 1,
					unscanned: 0,
					deferred: 0,
				})
				expect(fixture.dismissed()).toEqual([])
			})
	)
})

layer(APP_MODE_OWNED)('RaiseService status', test => {
	test.effect(
		'a status that should turn success is listed and raised with no change request',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				fixture.api.reviews.splice(1, 1)
				expect((yield* fixture.findDue).pulls).toEqual([17])
				expect(yield* fixture.raise).toEqual({
					outcome: 'raised',
					head: 'head',
					status: READY,
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.status.statuses).toEqual([{ sha: 'head', ...READY }])
			})
	)
	test.effect(
		'a status already success with no change request is neither listed nor written',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(undefined, undefined, READY)
				fixture.api.reviews.splice(1, 1)
				expect((yield* fixture.findDue).pulls).toEqual([])
				expect((yield* fixture.raise).outcome).toBe('not-due')
				expect(fixture.status.statuses).toEqual([])
			})
	)
	test.effect(
		'with no status of the bot on the head only the change request is lifted',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(undefined, undefined, null)
				expect((yield* fixture.findDue).pulls).toEqual([17])
				expect(yield* fixture.raise).toEqual({
					outcome: 'raised',
					head: 'head',
					dismissal: { dismissed: 1, failed: 0 },
				})
				expect(fixture.status.statuses).toEqual([])
			})
	)
	for (const recorded of ['a bug', 'an owner wait'] as const)
		test.effect(
			`a publisher that records ${recorded} and writes failure after find gets no success over it`,
			() =>
				Effect.gen(function* () {
					const fixture = raiseSetup()
					expect((yield* fixture.findDue).pulls).toEqual([17])
					// A reply run in the group before the locked job: it records what blocks and writes failure.
					if (recorded === 'a bug')
						fixture.api.threads.splice(0, 1, reviewThread())
					else
						fixture.api.reviews.push(
							summaryReview(
								{ ...ON_HEAD, finished: true, needsOwner: ['thread'] },
								{ id: 'waiting-103', databaseId: 103, author: APP_AUTHOR }
							)
						)
					const blocking =
						recorded === 'a bug'
							? ONE_BUG
							: toCommitStatus('needs owner', 0, true)
					fixture.status.statuses.push({ sha: 'head', ...blocking })
					expect((yield* fixture.raise).outcome).toBe('not-due')
					expect(fixture.status.statuses).toEqual([
						{ sha: 'head', ...blocking },
					])
					expect(fixture.dismissed()).toEqual([])
				})
		)
	test.effect(
		'a status written between the judgment and the writes keeps the status and the change request',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				const lowered = {
					sha: 'head',
					state: 'pending',
					description: 'written by another writer',
				} as const
				// The sweep, outside the group, lowers the status while the locked job reads the threads.
				fixture.api.threadSnapshots.shift = () => {
					fixture.status.statuses.push(lowered)
					return undefined
				}
				expect(yield* fixture.raise).toEqual({
					outcome: 'changed',
					head: 'head',
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.status.statuses).toEqual([lowered])
				expect(fixture.dismissed()).toEqual([])
			})
	)
})

/** The bot's `failure` while a thread waits for the owner and nothing else blocks. */
const OWNER_WAIT = toCommitStatus('needs owner', 0, true)

/**
 * Pull request 17 whose only blocker is the summary's wait on `thread`, a bug thread `resolver`'s
 * login resolved by hand with no reply, with the bot's `failure` and its change request standing.
 */
function ownerWaitSetup(role: string, allow: readonly string[]) {
	const fixture = raiseSetup(undefined, undefined, OWNER_WAIT, allow)
	fixture.api.command.role = role
	fixture.api.reviews.splice(
		0,
		1,
		summaryReview(
			{ ...ON_HEAD, finished: true, needsOwner: ['thread'] },
			{ databaseId: 101, author: APP_AUTHOR }
		)
	)
	fixture.api.threads.splice(
		0,
		1,
		reviewThread(undefined, {
			isResolved: true,
			resolvedBy: { login: 'contributor' },
		})
	)
	return fixture
}

layer(APP_MODE_OWNED)('RaiseService owner waits', test => {
	for (const [resolver, role, allow] of [
		['an admin', 'admin', []],
		['a login in commands.allow', 'write', ['contributor']],
	] as const)
		test.effect(
			`${resolver} resolving the waiting thread by hand turns the status green and lifts the change request in one schedule run`,
			() =>
				Effect.gen(function* () {
					const fixture = ownerWaitSetup(role, allow)
					// One run of the schedule file: the sweep leaves the `failure`, the locked job raises.
					expect(yield* fixture.sweep).toEqual({
						checked: 1,
						updated: 0,
						failed: 0,
					})
					expect((yield* fixture.findReplies).candidates).toEqual([])
					expect((yield* fixture.findDue).pulls).toEqual([17])
					expect(yield* fixture.raise).toEqual({
						outcome: 'raised',
						head: 'head',
						status: READY,
						dismissal: { dismissed: 1, failed: 0 },
					})
					expect(fixture.status.statuses).toEqual([{ sha: 'head', ...READY }])
					expect(
						fixture.api.reviews.filter(
							review => review.state === 'CHANGES_REQUESTED'
						)
					).toEqual([])
				})
		)
	test.effect(
		'a writer outside commands.allow resolving the waiting thread raises nothing and the wait stays',
		() =>
			Effect.gen(function* () {
				const fixture = ownerWaitSetup('write', [])
				expect(yield* fixture.sweep).toEqual({
					checked: 1,
					updated: 0,
					failed: 0,
				})
				expect((yield* fixture.findDue).pulls).toEqual([])
				expect(yield* fixture.raise).toEqual({
					outcome: 'not-due',
					head: 'head',
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.status.statuses).toEqual([])
				expect(fixture.dismissed()).toEqual([])
				expect(fixture.api.reviews[1]?.state).toBe('CHANGES_REQUESTED')
			})
	)
})

layer(APP_MODE_OWNED)('RaiseService blocking statuses', test => {
	test.effect(
		'an owner wait cleared on a head whose last full run did not finish turns failure into error under the lock',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(
					undefined,
					undefined,
					toCommitStatus('needs owner', 0, false)
				)
				fixture.api.command.role = 'admin'
				// The summary of a full run that did not finish waits on the thread an admin resolved.
				fixture.api.reviews.splice(
					0,
					fixture.api.reviews.length,
					summaryReview(
						{ ...ON_HEAD, finished: false, needsOwner: ['thread'] },
						{ databaseId: 101, author: APP_AUTHOR }
					)
				)
				fixture.api.threads.splice(
					0,
					1,
					reviewThread(undefined, {
						isResolved: true,
						resolvedBy: { login: 'contributor' },
					})
				)
				const unfinished = toCommitStatus('ready', 0, false)
				expect(yield* fixture.sweep).toMatchObject({ updated: 0 })
				expect((yield* fixture.findDue).pulls).toEqual([17])
				expect(yield* fixture.raise).toEqual({
					outcome: 'updated',
					head: 'head',
					status: unfinished,
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.status.statuses).toEqual([
					{ sha: 'head', ...unfinished },
				])
			})
	)
	test.effect(
		"2 of 3 bug threads resolved by hand update the failure's count under the lock",
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(
					undefined,
					undefined,
					toCommitStatus('needs fixes', 3, true)
				)
				fixture.api.reviews.splice(1, 1)
				fixture.api.threads.splice(
					0,
					1,
					reviewThread(undefined, { id: 'open' }),
					reviewThread(undefined, { id: 'first', isResolved: true }),
					reviewThread(undefined, { id: 'second', isResolved: true })
				)
				expect(yield* fixture.sweep).toMatchObject({ updated: 0 })
				expect((yield* fixture.findDue).pulls).toEqual([17])
				expect(yield* fixture.raise).toEqual({
					outcome: 'updated',
					head: 'head',
					status: ONE_BUG,
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.status.statuses).toEqual([{ sha: 'head', ...ONE_BUG }])
			})
	)
	test.effect(
		'an unfinished error that names its cause is neither listed nor rewritten as a generic one',
		() =>
			Effect.gen(function* () {
				const offline = {
					state: 'error',
					description: `the reviewer was offline; ${UNFINISHED_NOTE}`,
				} as const
				const fixture = raiseSetup(undefined, undefined, offline)
				fixture.api.reviews.splice(
					0,
					fixture.api.reviews.length,
					summaryReview(
						{ ...ON_HEAD, finished: false },
						{ databaseId: 101, author: APP_AUTHOR }
					)
				)
				expect((yield* fixture.findDue).pulls).toEqual([])
				expect((yield* fixture.raise).outcome).toBe('not-due')
				expect(fixture.status.statuses).toEqual([])
			})
	)
	test.effect(
		'a blocking status that already says what the threads say is neither listed nor written',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				fixture.api.reviews.splice(1, 1)
				fixture.api.threads.splice(0, 1, reviewThread())
				expect((yield* fixture.findDue).pulls).toEqual([])
				expect((yield* fixture.raise).outcome).toBe('not-due')
				expect(fixture.status.statuses).toEqual([])
			})
	)
	test.effect(
		'a green head under an unfinished full run is lowered to error while the stale change request is lifted',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(undefined, undefined, READY)
				const unfinishedRun = { ...ON_HEAD, finished: false }
				fixture.api.reviews.splice(
					0,
					fixture.api.reviews.length,
					summaryReview(unfinishedRun, {
						databaseId: 101,
						author: APP_AUTHOR,
					}),
					changeRequest({}, unfinishedRun)
				)
				const lowered = toCommitStatus('ready', 0, false)
				expect((yield* fixture.findDue).pulls).toEqual([17])
				expect(yield* fixture.raise).toEqual({
					outcome: 'raised',
					head: 'head',
					status: lowered,
					dismissal: { dismissed: 1, failed: 0 },
				})
				expect(fixture.status.statuses).toEqual([{ sha: 'head', ...lowered }])
				expect(fixture.dismissed()).toEqual([102])
			})
	)
})

/** GitHub refusing a status write, as at the per-context status limit of a commit. */
const REFUSED_STATUS = new GitHubApiError({
	operation: 'setStatus',
	reason: 'too many statuses',
	status: 422,
})

layer(APP_MODE_OWNED)('RaiseService writes', test => {
	test.effect(
		'a push while the status is written keeps the change requests and reports the status written',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				const { pullRequest } = fixture.api.command
				// The judgment's read and the one before the writes see the head; the one before the
				// dismissal sees the push.
				fixture.api.pullRequestSnapshots.push(pullRequest, pullRequest, {
					...pullRequest,
					head: { ...pullRequest.head, sha: 'next-head' },
				})
				expect(yield* fixture.raise).toEqual({
					outcome: 'raised',
					head: 'head',
					status: READY,
					dismissal: { dismissed: 0, failed: 0 },
					movedBeforeDismissal: true,
				})
				expect(fixture.status.statuses).toEqual([{ sha: 'head', ...READY }])
				expect(fixture.dismissed()).toEqual([])
				expect(fixture.api.reviews[1]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'a refused status write is reported and the due dismissal still runs',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(undefined, undefined, undefined, [], () =>
					Effect.fail(REFUSED_STATUS)
				)
				expect(yield* fixture.raise).toEqual({
					outcome: 'raised',
					head: 'head',
					statusError: REFUSED_STATUS.message,
					dismissal: { dismissed: 1, failed: 0 },
				})
				expect(fixture.dismissed()).toEqual([102])
			})
	)
	test.effect(
		'a refused status write with nothing to dismiss is reported as refused',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(undefined, undefined, undefined, [], () =>
					Effect.fail(REFUSED_STATUS)
				)
				fixture.api.reviews.splice(1, 1)
				expect(yield* fixture.raise).toEqual({
					outcome: 'refused',
					head: 'head',
					statusError: REFUSED_STATUS.message,
					dismissal: { dismissed: 0, failed: 0 },
				})
			})
	)
})

/** Five open pull requests on the same head, every one with a raise due. */
const FIVE_PULLS = [17, 18, 19, 20, 21].map(number =>
	openPullRequest(number, 'head')
)
/** How long one judgment's status read takes on the test clock. */
const SLOW_READ = Duration.seconds(40)
/** A deadline that lets three such judgments start and stops the fourth. */
const SCAN_BUDGET = Duration.seconds(100)

layer(APP_MODE_OWNED)('RaiseService scan deadline', test => {
	test.effect(
		'a listing of the open pull requests that never ends is cut at the hard bound',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake(APP_IDENTITY)
				const status = githubStatusFake({
					listOpenPullRequests: () => Effect.never,
				})
				const now = yield* Clock.currentTimeMillis
				const fiber = yield* RaiseService.use(service =>
					service.findDue([], {
						rotation: 0,
						bound: now + Duration.toMillis(Duration.minutes(3)),
					})
				).pipe(
					Effect.provide(
						RaiseServiceLive.pipe(
							Layer.provide(Layer.mergeAll(api.api, status.layer))
						)
					),
					Effect.forkChild
				)
				yield* TestClock.adjust(Duration.minutes(10))
				expect(fiber.pollUnsafe()).toBeDefined()
				expect(yield* Fiber.join(fiber)).toEqual({
					pulls: [],
					read: 0,
					failed: 0,
					unscanned: 0,
					deferred: 0,
					stop: 'bound',
				})
			})
	)
	test.effect(
		'a judgment that never ends is dropped at the hard bound and the judgments before it are kept',
		() =>
			Effect.gen(function* () {
				// The second pull request's status read never returns.
				const fixture = raiseSetup(
					FIVE_PULLS,
					'head',
					ONE_BUG,
					[],
					undefined,
					undefined,
					2
				)
				const now = yield* Clock.currentTimeMillis
				const fiber = yield* fixture
					.findDueWith({
						rotation: 0,
						deadline: now + Duration.toMillis(SCAN_BUDGET),
						bound: now + Duration.toMillis(Duration.minutes(3)),
					})
					.pipe(Effect.forkChild)
				yield* TestClock.adjust(Duration.minutes(10))
				expect(fiber.pollUnsafe()).toBeDefined()
				expect(yield* Fiber.join(fiber)).toEqual({
					pulls: [17],
					read: 5,
					failed: 0,
					unscanned: 4,
					deferred: 0,
					dropped: 18,
					stop: 'bound',
				})
			})
	)
	test.effect(
		'a deadline that passed before the scan started still judges the pull request at its start',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(FIVE_PULLS)
				const deadline = (yield* Clock.currentTimeMillis) - 1
				expect(yield* fixture.findDueWith({ rotation: 1, deadline })).toEqual({
					pulls: [18],
					read: 5,
					failed: 0,
					unscanned: 4,
					deferred: 0,
				})
			})
	)
	test.effect(
		'a judgment that runs long past the deadline is finished and counted',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(
					FIVE_PULLS,
					'head',
					ONE_BUG,
					[],
					undefined,
					Duration.minutes(5)
				)
				const deadline = (yield* Clock.currentTimeMillis) + 1000
				const fiber = yield* fixture
					.findDueWith({ rotation: 0, deadline })
					.pipe(Effect.forkChild)
				yield* TestClock.adjust(Duration.minutes(10))
				expect(yield* Fiber.join(fiber)).toEqual({
					pulls: [17],
					read: 5,
					failed: 0,
					unscanned: 4,
					deferred: 0,
				})
			})
	)
	test.effect(
		'ticks that judge only the pull request at their start still reach every one within N ticks',
		() =>
			Effect.gen(function* () {
				// 40 open pull requests and a limit of 20 share factors; the starts must still visit all.
				const open = Array.from({ length: 40 }, (_, index) =>
					openPullRequest(index + 1, 'head')
				)
				const fixture = raiseSetup(open)
				const listed = new Set<number>()
				for (let rotation = 0; rotation < open.length; rotation += 1) {
					const deadline = (yield* Clock.currentTimeMillis) - 1
					const found = yield* fixture.findDueWith({
						rotation,
						deadline,
						limit: 20,
					})
					expect(found.pulls).toHaveLength(1)
					for (const pull of found.pulls) listed.add(pull)
				}
				expect(listed.size).toBe(open.length)
			})
	)
	for (const [rotation, pulls] of [
		[0, [17, 18]],
		[1, [19, 20]],
	] as const)
		test.effect(
			`a scan with run number ${rotation} makes its limit of full judgments, starts that far along and defers the rest`,
			() =>
				Effect.gen(function* () {
					const fixture = raiseSetup(FIVE_PULLS)
					expect(yield* fixture.findDueWith({ rotation, limit: 2 })).toEqual({
						pulls,
						read: 5,
						failed: 0,
						unscanned: 0,
						deferred: 3,
					})
				})
		)
	test.effect(
		'a scan past its deadline keeps the judgments made so far and counts the rest',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(
					FIVE_PULLS,
					'head',
					ONE_BUG,
					[],
					undefined,
					SLOW_READ
				)
				const deadline =
					(yield* Clock.currentTimeMillis) + Duration.toMillis(SCAN_BUDGET)
				const fiber = yield* fixture
					.findDueWith({ rotation: 0, deadline })
					.pipe(Effect.forkChild)
				yield* TestClock.adjust(Duration.minutes(5))
				expect(yield* Fiber.join(fiber)).toEqual({
					pulls: [17, 18, 19],
					read: 5,
					failed: 0,
					unscanned: 2,
					deferred: 0,
				})
			})
	)
	test.effect(
		'ticks that cannot finish the scan list every due pull request within a few run numbers',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(
					FIVE_PULLS,
					'head',
					ONE_BUG,
					[],
					undefined,
					SLOW_READ
				)
				const listed = new Set<number>()
				// Three judgments fit in a tick, so with one more starting point per run number every
				// one of the five is listed by the third tick.
				for (const rotation of [0, 1, 2]) {
					const deadline =
						(yield* Clock.currentTimeMillis) + Duration.toMillis(SCAN_BUDGET)
					const fiber = yield* fixture
						.findDueWith({ rotation, deadline })
						.pipe(Effect.forkChild)
					yield* TestClock.adjust(Duration.minutes(5))
					const found = yield* Fiber.join(fiber)
					expect(found.pulls).toHaveLength(3)
					for (const pull of found.pulls) listed.add(pull)
				}
				expect([...listed].toSorted((a, b) => a - b)).toEqual([
					17, 18, 19, 20, 21,
				])
			})
	)
})

layer(APP_MODE_OWNED)('RaiseService closed and refused', test => {
	test.effect('a pull request closed before the writes gets none', () =>
		Effect.gen(function* () {
			const fixture = raiseSetup()
			const { pullRequest } = fixture.api.command
			fixture.api.pullRequestSnapshots.push(pullRequest, {
				...pullRequest,
				state: 'closed',
			})
			expect(yield* fixture.raise).toEqual({
				outcome: 'closed',
				head: 'head',
				dismissal: { dismissed: 0, failed: 0 },
			})
			expect(fixture.status.statuses).toEqual([])
			expect(fixture.dismissed()).toEqual([])
		})
	)
	test.effect(
		'a pull request closed after the status write keeps its change requests and reports the status',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup()
				const { pullRequest } = fixture.api.command
				fixture.api.pullRequestSnapshots.push(pullRequest, pullRequest, {
					...pullRequest,
					state: 'closed',
				})
				expect(yield* fixture.raise).toEqual({
					outcome: 'raised',
					head: 'head',
					status: READY,
					dismissal: { dismissed: 0, failed: 0 },
					closedBeforeDismissal: true,
				})
				expect(fixture.status.statuses).toEqual([{ sha: 'head', ...READY }])
				expect(fixture.dismissed()).toEqual([])
			})
	)
	test.effect(
		'a dismissal GitHub refuses with no status to write is reported as refused, not raised',
		() =>
			Effect.gen(function* () {
				const fixture = raiseSetup(undefined, undefined, READY)
				fixture.api.failures.dismissReview.push(
					new GitHubApiError({
						operation: 'dismissReview',
						reason: 'Denied',
						status: 403,
					})
				)
				expect(yield* fixture.raise).toEqual({
					outcome: 'refused',
					head: 'head',
					dismissal: { dismissed: 0, failed: 1 },
				})
			})
	)
})

/** When the earlier full run finished, a minute before and after it, and after the test's writes. */
const EARLIER_AT = '2026-11-20T09:59:00Z'
const REVIEWED_AT = '2026-11-20T10:00:00Z'
const LATER_AT = '2026-11-20T10:01:00Z'
const RELEASED_AT = '2026-11-20T10:03:00Z'

/** The `error`s a run writes when it ends without writing a finished summary. */
const RUN_ERRORS = {
	'publishing failed': `publishing failed; ${UNFINISHED_NOTE}`,
	'reviewer offline': `the reviewer was offline; ${UNFINISHED_NOTE}`,
} as const

/** A finished full run on the head that stamped `reviewedAt` (unset: a marker from before the stamp). */
function finishedMarker(reviewedAt?: string): SummaryMarker {
	return {
		...ON_HEAD,
		finished: true,
		...(reviewedAt === undefined ? {} : { reviewedAt }),
	}
}

/** What the head's `error` says and when it was written; unset `at` is a status without the time. */
interface SeededError {
	readonly description: string
	readonly at?: string
}

/** When GitHub says the summary review was posted and last edited. */
type WrittenTimes = Pick<
	PullRequestReview,
	'createdAt' | 'submittedAt' | 'lastEditedAt'
>

/**
 * `raiseSetup` after a full run that finished on the head: its summary and its change request with
 * `marker`, posted or edited at `written`, and the `error` a later run wrote on the head.
 */
function erroredSetup(
	error: SeededError,
	marker: SummaryMarker,
	written: WrittenTimes = {}
) {
	const fixture = raiseSetup(undefined, undefined, {
		state: 'error',
		description: error.description,
		...(error.at === undefined ? {} : { created_at: error.at }),
	})
	fixture.api.reviews.splice(
		0,
		fixture.api.reviews.length,
		summaryReview(marker, { databaseId: 101, author: APP_AUTHOR, ...written }),
		changeRequest(written, marker)
	)
	return fixture
}

layer(APP_MODE_OWNED)('RaiseService errors a later run wrote', test => {
	for (const [name, description] of Object.entries(RUN_ERRORS))
		test.effect(
			`a ${name} error written after the finished run on the head keeps the error and the change request`,
			() =>
				Effect.gen(function* () {
					const fixture = erroredSetup(
						{ description, at: LATER_AT },
						finishedMarker(REVIEWED_AT)
					)
					expect((yield* fixture.findDue).pulls).toEqual([])
					expect(yield* fixture.raise).toEqual({
						outcome: 'not-due',
						head: 'head',
						dismissal: { dismissed: 0, failed: 0 },
					})
					expect(fixture.status.statuses).toEqual([])
					expect(fixture.dismissed()).toEqual([])
				})
		)
	const laterEdits = [
		{
			name: 'a reply-only run',
			marker: { ...finishedMarker(REVIEWED_AT), needsOwner: ['waiting'] },
		},
		{
			name: 'a manual run reserving its review',
			marker: { ...finishedMarker(REVIEWED_AT), manualRuns: 1 },
		},
	] as const
	for (const { name, marker } of laterEdits)
		test.effect(
			`an edit by ${name} after the error keeps the error and the change request`,
			() =>
				Effect.gen(function* () {
					// The edit carries the finished flag and the stamp of the earlier full run forward.
					const fixture = erroredSetup(
						{ description: RUN_ERRORS['publishing failed'], at: LATER_AT },
						marker,
						{
							createdAt: EARLIER_AT,
							submittedAt: EARLIER_AT,
							lastEditedAt: RELEASED_AT,
						}
					)
					fixture.api.threads.push(
						reviewThread(undefined, {
							id: 'waiting',
							isResolved: true,
							resolvedBy: { login: 'contributor' },
						})
					)
					fixture.api.command.role = 'admin'
					expect((yield* fixture.findDue).pulls).toEqual([])
					expect((yield* fixture.raise).outcome).toBe('not-due')
					expect(fixture.status.statuses).toEqual([])
					expect(fixture.dismissed()).toEqual([])
				})
		)
	const unknownOrders = [
		{
			name: 'an error without its time',
			error: { description: RUN_ERRORS['publishing failed'] },
			marker: finishedMarker(REVIEWED_AT),
		},
		{
			name: 'a finished marker from before the stamp',
			error: { description: RUN_ERRORS['publishing failed'], at: LATER_AT },
			marker: finishedMarker(),
		},
		{
			name: 'an error in the same second as the finished run',
			error: { description: RUN_ERRORS['publishing failed'], at: REVIEWED_AT },
			marker: finishedMarker(REVIEWED_AT),
		},
	] as const
	for (const { name, error, marker } of unknownOrders)
		test.effect(
			`${name} cannot be ordered, so the error and the change request stay`,
			() =>
				Effect.gen(function* () {
					const fixture = erroredSetup(error, marker)
					expect((yield* fixture.findDue).pulls).toEqual([])
					expect((yield* fixture.raise).outcome).toBe('not-due')
					expect(fixture.status.statuses).toEqual([])
					expect(fixture.dismissed()).toEqual([])
				})
		)
	test.effect('a full run that finished after the error still raises', () =>
		Effect.gen(function* () {
			// Its own status write failed, so the head still shows the older error.
			const fixture = erroredSetup(
				{ description: RUN_ERRORS['publishing failed'], at: EARLIER_AT },
				finishedMarker(REVIEWED_AT)
			)
			expect((yield* fixture.findDue).pulls).toEqual([17])
			expect(yield* fixture.raise).toEqual({
				outcome: 'raised',
				head: 'head',
				status: READY,
				dismissal: { dismissed: 1, failed: 0 },
			})
			expect(fixture.dismissed()).toEqual([102])
		})
	)
	test.effect(
		'a later error survives a lowering to failure and a hand resolve, until a full run finishes',
		() =>
			Effect.gen(function* () {
				// Run B on the same head posted a bug thread, then its publishing failed.
				const fixture = erroredSetup(
					{ description: RUN_ERRORS['publishing failed'], at: LATER_AT },
					finishedMarker(REVIEWED_AT)
				)
				fixture.api.threads.splice(0, 1, reviewThread())
				const unfinishedBug = toCommitStatus('needs fixes', 1, false)
				expect(yield* fixture.sweep).toMatchObject({ updated: 1 })
				expect(fixture.status.statuses).toEqual([
					{ sha: 'head', ...unfinishedBug },
				])
				expect((yield* fixture.findDue).pulls).toEqual([])
				// A writer resolves B's thread: the failure, written after the finished run, still holds.
				fixture.api.threads.splice(
					0,
					1,
					reviewThread(undefined, { isResolved: true })
				)
				expect(yield* fixture.sweep).toMatchObject({ updated: 0 })
				expect((yield* fixture.findDue).pulls).toEqual([17])
				const unfinished = toCommitStatus('ready', 0, false)
				expect(yield* fixture.raise).toEqual({
					outcome: 'updated',
					head: 'head',
					status: unfinished,
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect((yield* fixture.findDue).pulls).toEqual([])
				expect(
					fixture.status.statuses.filter(status => status.state === 'success')
				).toEqual([])
				expect(fixture.dismissed()).toEqual([])
				// A full run finishes on the head after those writes; its own status write failed.
				const released = finishedMarker(RELEASED_AT)
				fixture.api.reviews.splice(
					0,
					fixture.api.reviews.length,
					summaryReview(released, { databaseId: 101, author: APP_AUTHOR }),
					changeRequest({}, released)
				)
				expect((yield* fixture.findDue).pulls).toEqual([17])
				expect(yield* fixture.raise).toMatchObject({
					outcome: 'raised',
					status: READY,
					dismissal: { dismissed: 1, failed: 0 },
				})
				expect(fixture.dismissed()).toEqual([102])
			})
	)
	test.effect(
		'an open bug thread over a later error writes a failure that keeps the unfinished note, and the change request stays',
		() =>
			Effect.gen(function* () {
				const fixture = erroredSetup(
					{ description: RUN_ERRORS['publishing failed'], at: LATER_AT },
					finishedMarker(REVIEWED_AT)
				)
				fixture.api.threads.splice(0, 1, reviewThread())
				expect((yield* fixture.findDue).pulls).toEqual([17])
				expect(yield* fixture.raise).toEqual({
					outcome: 'updated',
					head: 'head',
					status: toCommitStatus('needs fixes', 1, false),
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.dismissed()).toEqual([])
			})
	)
})
