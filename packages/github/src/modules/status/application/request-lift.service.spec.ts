import { layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'
import type {
	OpenPullRequest,
	PullRequestReview,
} from '../../../platform/github-api.schema'
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
import { toCommitStatus } from '../domain/status.helper'
import {
	RequestLiftService,
	RequestLiftServiceLive,
} from './request-lift.service'
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

/**
 * Pull request 17 on `head`: a finished summary of the app on the head, the app's change request,
 * one bug thread a person resolved by hand and a `failure` status, so a lift is due.
 */
function liftSetup(
	pulls: readonly OpenPullRequest[] = [openPullRequest(17, 'head')],
	head = 'head'
) {
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
		listOpenPullRequests: () => Effect.succeed(pulls),
		getStatus: () =>
			Effect.succeed({
				id: status.statuses.length + 1,
				...toCommitStatus('needs fixes', 1, true),
				...status.statuses.at(-1),
				context: 'MNG Review',
				creator: null,
			}),
	})
	const services = Layer.mergeAll(
		RequestLiftServiceLive,
		StatusSweepServiceLive,
		ReplyFindServiceLive.pipe(Layer.provide(SummaryReviewServiceLive))
	).pipe(Layer.provide(Layer.mergeAll(api.api, status.layer, READ_CONFIG)))
	const findDue = RequestLiftService.use(service => service.findDue([])).pipe(
		Effect.provide(services)
	)
	const lift = RequestLiftService.use(service => service.lift(17, [])).pipe(
		Effect.provide(services)
	)
	const sweep = StatusSweepService.use(service => service.sweep()).pipe(
		Effect.provide(services)
	)
	const findReplies = ReplyFindService.use(service =>
		service.find({ max: 5, rotation: 0 })
	).pipe(Effect.provide(services))
	const dismissed = () =>
		api.writes.flatMap(write =>
			write.method === 'dismissReview' ? [write.id] : []
		)
	return { api, status, findDue, lift, sweep, findReplies, dismissed }
}

layer(APP_MODE_OWNED)('RequestLiftService schedule run', test => {
	test.effect(
		'the last thread resolved by hand turns the status green and lifts the change request in one schedule run',
		() =>
			Effect.gen(function* () {
				const fixture = liftSetup()
				// One run of the schedule file: the sweep, then the reply schedule's find and locked job.
				expect(yield* fixture.sweep).toEqual({
					checked: 1,
					updated: 1,
					failed: 0,
				})
				expect((yield* fixture.findReplies).candidates).toEqual([])
				expect(yield* fixture.findDue).toEqual({
					pulls: [17],
					read: 1,
					failed: 0,
				})
				expect(yield* fixture.lift).toEqual({
					outcome: 'lifted',
					head: 'head',
					dismissal: { dismissed: 1, failed: 0 },
				})
				expect(fixture.status.statuses).toEqual([
					{ sha: 'head', ...toCommitStatus('ready', 0, true) },
				])
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
		'a pull request with a reply and a due lift is listed once on each side, and a second lift dismisses nothing',
		() =>
			Effect.gen(function* () {
				const fixture = liftSetup([openPullRequest(17, FULL_HEAD)], FULL_HEAD)
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
				// The workflow runs the lift entry after the reply's publish leg; a repeat finds nothing left.
				expect((yield* fixture.lift).outcome).toBe('lifted')
				expect((yield* fixture.lift).outcome).toBe('not-due')
				expect(fixture.dismissed()).toEqual([102])
			})
	)
})

layer(APP_MODE_OWNED)('RequestLiftService incomplete reads', test => {
	for (const list of ['threads', 'comments', 'reviews'] as const)
		test.effect(`a null node in the ${list} lists no lift in find`, () =>
			Effect.gen(function* () {
				const fixture = liftSetup()
				fixture.api.nullNodes[list] = 1
				expect(
					yield* fixture.findDue.pipe(provideListCompleteness(false))
				).toEqual({ pulls: [], read: 1, failed: 0 })
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
				const fixture = liftSetup()
				expect(
					(yield* fixture.findDue.pipe(provideListCompleteness(false))).pulls
				).toEqual([17])
				fixture.api.nullNodes.threads = 1
				expect(
					yield* fixture.lift.pipe(provideListCompleteness(false))
				).toEqual({
					outcome: 'incomplete',
					head: 'head',
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.dismissed()).toEqual([])
				expect(fixture.api.reviews[1]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'a null node on one pull request leaves the next one free to be listed',
		() =>
			Effect.gen(function* () {
				const fixture = liftSetup([
					openPullRequest(17, 'head'),
					openPullRequest(18, 'head'),
				])
				// Only the first pull request's thread read lists a null node.
				fixture.api.nullNodes.queued.threads.push(1, 0)
				expect(
					yield* fixture.findDue.pipe(provideListCompleteness(false))
				).toEqual({ pulls: [18], read: 2, failed: 0 })
			})
	)
})

layer(APP_MODE_OWNED)('RequestLiftService under the lock', test => {
	test.effect('a bug reopened after find keeps the change request', () =>
		Effect.gen(function* () {
			const fixture = liftSetup()
			expect((yield* fixture.findDue).pulls).toEqual([17])
			// A reply run reopens the bug thread before the lift job gets the group.
			fixture.api.threads.splice(0, 1, reviewThread())
			expect(yield* fixture.lift).toEqual({
				outcome: 'not-due',
				head: 'head',
				dismissal: { dismissed: 0, failed: 0 },
			})
			expect(fixture.dismissed()).toEqual([])
		})
	)
	test.effect('a wait recorded after find keeps the change request', () =>
		Effect.gen(function* () {
			const fixture = liftSetup()
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
			expect((yield* fixture.lift).outcome).toBe('not-due')
			expect(fixture.dismissed()).toEqual([])
		})
	)
	test.effect(
		'an unfinished summary an incomplete write left keeps the change request',
		() =>
			Effect.gen(function* () {
				const fixture = liftSetup()
				fixture.api.reviews.push(
					summaryReview(
						{ ...SUMMARY_MARKER, head: 'head', finished: false, failed: true },
						{ id: 'unfinished-103', databaseId: 103, author: APP_AUTHOR }
					)
				)
				expect((yield* fixture.findDue).pulls).toEqual([])
				expect((yield* fixture.lift).outcome).toBe('not-due')
				expect(fixture.dismissed()).toEqual([])
			})
	)
	test.effect(
		'a change request posted while the lift read the threads is never dismissed',
		() =>
			Effect.gen(function* () {
				const fixture = liftSetup()
				const later = changeRequest({ id: 'later-request', databaseId: 104 })
				// The new request lands after the review read, while the threads are read.
				fixture.api.threadSnapshots.shift = () => {
					fixture.api.reviews.push(later)
					return undefined
				}
				expect((yield* fixture.lift).dismissal).toEqual({
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
				const fixture = liftSetup()
				const { pullRequest } = fixture.api.command
				fixture.api.pullRequestSnapshots.push(pullRequest, {
					...pullRequest,
					head: { ...pullRequest.head, sha: 'next-head' },
				})
				expect(yield* fixture.lift).toEqual({
					outcome: 'moved',
					head: 'head',
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.dismissed()).toEqual([])
			})
	)
	test.effect('a closed pull request is left alone', () =>
		Effect.gen(function* () {
			const fixture = liftSetup()
			fixture.api.command.pullRequest = {
				...fixture.api.command.pullRequest,
				state: 'closed',
			}
			expect(yield* fixture.lift).toEqual({
				outcome: 'closed',
				dismissal: { dismissed: 0, failed: 0 },
			})
			expect(fixture.api.reads).toEqual(['getPullRequest:17'])
			expect(fixture.dismissed()).toEqual([])
		})
	)
	test.effect('a failed read fails the lift and dismisses nothing', () =>
		Effect.gen(function* () {
			const fixture = liftSetup()
			fixture.api.failures.listThreads.push(
				new GitHubApiError({
					operation: 'listReviewThreads',
					reason: 'Unavailable',
					status: 503,
				})
			)
			expect(yield* Effect.flip(fixture.lift)).toMatchObject({
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
					const fixture = liftSetup()
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
					expect((yield* fixture.lift).dismissal).toEqual(
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
					const fixture = liftSetup()
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
					expect((yield* fixture.lift).outcome).toBe(
						open ? 'not-due' : 'lifted'
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
					const fixture = liftSetup()
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
					expect((yield* fixture.findDue).pulls).toEqual(
						unthreadedBugs > 0 ? [] : [17]
					)
					expect((yield* fixture.lift).outcome).toBe(
						unthreadedBugs > 0 ? 'not-due' : 'lifted'
					)
					expect(fixture.dismissed()).toEqual(unthreadedBugs > 0 ? [] : [102])
					expect(fixture.status.statuses).toEqual([])
				})
		)
})

layer(APP_MODE_OWNED)('RequestLiftService find', test => {
	test.effect(
		'a pull request with no change request of the current identity reads nothing past its reviews',
		() =>
			Effect.gen(function* () {
				const fixture = liftSetup()
				fixture.api.reviews.splice(1, 1)
				expect(yield* fixture.findDue).toEqual({
					pulls: [],
					read: 1,
					failed: 0,
				})
				expect(fixture.api.threadReads).toEqual([])
				expect(fixture.api.commentReads).toEqual([])
			})
	)
	test.effect(
		'a read that fails on one pull request is counted and the next one is listed',
		() =>
			Effect.gen(function* () {
				const fixture = liftSetup([
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
				})
				expect(fixture.dismissed()).toEqual([])
			})
	)
})
