import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import type { PullRequestReview } from '../../../platform/github-api.schema'
import {
	type ReviewEvent,
	REVIEW_STATE_BY_EVENT,
	REVIEW_EVENTS,
} from '../../../platform/github-review.service'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { GITHUB_SETTINGS } from '../../../shared/mocks/github-http.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	COVERED_REVIEW,
	summaryReview,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import type { ReviewEvidence } from '../domain/review-event.helper'
import { toBodyWithoutHeadline } from '../presentation/review-headline.formatter'
import {
	toOutlivedReviewMessage,
	toReplacedApprovalMessage,
	toStaleApprovalMessage,
} from '../presentation/summary-status.formatter'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import {
	SummaryReviewService,
	SummaryReviewServiceLive,
} from './summary-review.service'
import type {
	SummaryDraft,
	SummaryRender,
} from './summary-review.service.types'

/** Evidence of a full review on the head that decides `event`. */
const EVIDENCE_BY_EVENT = {
	APPROVE: { ...COVERED_REVIEW },
	COMMENT: { ...COVERED_REVIEW, gap: { kind: 'findings', findings: 1 } },
	REQUEST_CHANGES: { ...COVERED_REVIEW, verdict: 'needs fixes' },
} as const satisfies Record<ReviewEvent, ReviewEvidence>

/** A marked body with evidence for an explicit event, or no new judgement for offline writes. */
function draft(event?: ReviewEvent): SummaryDraft {
	return {
		head: 'reviewed-head',
		render: () => ({
			body: toMarkerComment('summary', SUMMARY_MARKER),
			marker: SUMMARY_MARKER,
			...(event === undefined ? {} : { evidence: EVIDENCE_BY_EVENT[event] }),
		}),
	}
}

/** Records review writes and failures without an HTTP client, on a pull request standing on `head`. */
function setup(head = 'reviewed-head') {
	const fake = githubApiFake(APP_IDENTITY)
	fake.command.pullRequest = {
		...fake.command.pullRequest,
		head: { ...fake.command.pullRequest.head, sha: head },
	}
	const service = SummaryReviewServiceLive.pipe(
		Layer.provide(
			Layer.merge(
				fake.api,
				Layer.succeed(GitHubConfig, {
					...GITHUB_SETTINGS,
					identity: APP_IDENTITY,
				})
			)
		)
	)
	return { fake, service }
}

/** Own review; all other fixture fields remain independently overridable. */
function own(overrides: Partial<PullRequestReview> = {}) {
	return summaryReview(SUMMARY_MARKER, {
		author: { __typename: 'Bot', login: APP_IDENTITY.login },
		commit: { oid: 'reviewed-head' },
		...overrides,
	})
}

layer(APP_MODE_OWNED)('SummaryReviewService review events', test => {
	for (const event of REVIEW_EVENTS) {
		test.effect(`edits a matching ${event} once without changing state`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(own({ state: REVIEW_STATE_BY_EVENT[event] }))
				const renderSpy = vi.fn(draft(event).render)
				const written = yield* SummaryReviewService.use(service =>
					service.write(17, { ...draft(event), render: renderSpy })
				).pipe(Effect.provide(fixture.service))
				expect(written).toMatchObject({
					event,
					created: false,
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.fake.writes).toEqual([
					{ method: 'updateReview', id: 101, body: written.body },
				])
				expect(fixture.fake.reviews[0]?.state).toBe(
					REVIEW_STATE_BY_EVENT[event]
				)
				expect(renderSpy).toHaveBeenCalledTimes(1)
			})
		)
		for (const prior of REVIEW_EVENTS.filter(candidate => candidate !== event))
			test.effect(`posts ${event} when the prior state was ${prior}`, () =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(
						own({ state: REVIEW_STATE_BY_EVENT[prior] })
					)
					const written = yield* SummaryReviewService.use(service =>
						service.write(17, draft(event))
					).pipe(Effect.provide(fixture.service))
					expect(written).toMatchObject({ event, created: true })
					expect(fixture.fake.writes[0]).toMatchObject({
						method: 'review',
						input: { event, comments: [] },
					})
					expect(
						fixture.fake.writes.some(write => write.method === 'updateReview')
					).toBe(false)
					expect(fixture.fake.reviews.at(-1)?.state).toBe(
						REVIEW_STATE_BY_EVENT[event]
					)
				})
			)
	}
	for (const event of [
		'COMMENT',
		'APPROVE',
		'REQUEST_CHANGES',
		undefined,
	] as const)
		test.effect(
			`dismisses only the stale owned change requests after ${event}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(
						own({ databaseId: 101, id: 'own', state: 'CHANGES_REQUESTED' }),
						summaryReview(SUMMARY_MARKER, {
							databaseId: 102,
							id: 'previous',
							state: 'CHANGES_REQUESTED',
							isMinimized: true,
						}),
						own({ databaseId: 103, id: 'approved', state: 'APPROVED' }),
						own({
							databaseId: 104,
							id: 'foreign',
							state: 'CHANGES_REQUESTED',
							author: { __typename: 'Bot', login: 'foreign' },
						}),
						own({ databaseId: 105, id: 'latest' })
					)
					const written = yield* SummaryReviewService.use(service =>
						service.write(17, draft(event))
					).pipe(Effect.provide(fixture.service))
					const ids =
						event === 'COMMENT' ? [101, 102] : event === 'APPROVE' ? [102] : []
					expect(
						fixture.fake.writes
							.filter(write => write.method === 'dismissReview')
							.map(write => write.id)
					).toEqual(ids)
					expect(written.dismissal).toStrictEqual({
						dismissed: ids.length,
						failed: 0,
					})
					for (const id of ids)
						expect(
							fixture.fake.reviews.find(review => review.databaseId === id)
								?.state
						).toBe('DISMISSED')
					expect(
						fixture.fake.reviews.find(review => review.databaseId === 104)
							?.state
					).toBe('CHANGES_REQUESTED')
					const methods = fixture.fake.writes.map(write => write.method)
					if (ids.length > 0)
						expect(methods.indexOf('dismissReview')).toBeGreaterThan(
							Math.max(
								methods.indexOf('review'),
								methods.indexOf('updateReview')
							)
						)
				})
		)
	test.effect(
		'ignores a failed dismissal, counts successes and retries the remaining request next time',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					own({ databaseId: 101, id: 'first', state: 'CHANGES_REQUESTED' }),
					own({ databaseId: 102, id: 'second', state: 'CHANGES_REQUESTED' })
				)
				fixture.fake.failures.dismissReview.push(
					new GitHubApiError({
						operation: 'dismissReview',
						reason: 'Denied',
						status: 403,
					})
				)
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, draft('COMMENT'))
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({
					dismissal: { dismissed: 1, failed: 1 },
					event: 'COMMENT',
				})
				expect(
					fixture.fake.reviews.find(review => review.databaseId === 101)?.state
				).toBe('CHANGES_REQUESTED')
				expect(
					fixture.fake.reviews.find(review => review.databaseId === 102)?.state
				).toBe('DISMISSED')
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, draft('COMMENT'))
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({ dismissal: { dismissed: 1, failed: 0 } })
				expect(
					fixture.fake.writes
						.filter(write => write.method === 'dismissReview')
						.map(write => write.id)
				).toEqual([101, 102, 101])
			})
	)
	for (const event of REVIEW_EVENTS)
		test.effect(`422 inline fallback preserves ${event}`, () =>
			Effect.gen(function* () {
				const fixture = setup('head')
				fixture.fake.failures.review.push(
					new GitHubApiError({
						operation: 'createReview',
						reason: 'Invalid line',
						status: 422,
					})
				)
				const renderSpy = vi.fn<SummaryRender>((_prior, inline) => ({
					body: inline ? 'Inline body' : 'Fallback body',
					marker: SUMMARY_MARKER,
					evidence: EVIDENCE_BY_EVENT[event],
				}))
				const written = yield* SummaryReviewService.use(service =>
					service.write(17, {
						head: 'head',
						comments: [{ path: 'src/example.ts', line: 7, body: 'Finding' }],
						render: renderSpy,
					})
				).pipe(Effect.provide(fixture.service))
				expect(written).toMatchObject({ event, inline: false })
				expect(toBodyWithoutHeadline(written.body)).toBe('Fallback body')
				const reviews = fixture.fake.writes.filter(
					write => write.method === 'review'
				)
				expect(reviews).toMatchObject([
					{ input: { event, comments: [{ line: 7 }] } },
					{ input: { event, comments: [] } },
				])
				expect(
					reviews.map(write => toBodyWithoutHeadline(write.input.body))
				).toEqual(['Inline body', 'Fallback body'])
				expect(renderSpy).toHaveBeenCalledTimes(2)
			})
		)
	test.effect(
		'422 fallback uses the new event returned by the second render',
		() =>
			Effect.gen(function* () {
				const fixture = setup('head')
				fixture.fake.failures.review.push(
					new GitHubApiError({
						operation: 'createReview',
						reason: 'Invalid line',
						status: 422,
					})
				)
				const written = yield* SummaryReviewService.use(service =>
					service.write(17, {
						head: 'head',
						comments: [{ path: 'src/example.ts', line: 7, body: 'Finding' }],
						render: (_prior, inline) => ({
							body: inline ? 'Inline' : 'Fallback',
							marker: SUMMARY_MARKER,
							evidence:
								EVIDENCE_BY_EVENT[inline ? 'REQUEST_CHANGES' : 'COMMENT'],
						}),
					})
				).pipe(Effect.provide(fixture.service))
				expect(written).toMatchObject({ event: 'COMMENT', inline: false })
				expect(
					fixture.fake.writes
						.filter(write => write.method === 'review')
						.map(write => write.input.event)
				).toEqual(['REQUEST_CHANGES', 'COMMENT'])
			})
	)
	for (const state of ['APPROVED', 'CHANGES_REQUESTED'] as const)
		test.effect(
			`offline edits an owned ${state} review without dismissing it`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(own({ state }))
					expect(
						yield* SummaryReviewService.use(service =>
							service.publishStatus({
								pullNumber: 17,
								head: 'reviewed-head',
								engineCommit: 'engine',
								status: 'offline',
							})
						).pipe(Effect.provide(fixture.service))
					).toMatchObject({ created: false })
					expect(fixture.fake.writes).toMatchObject([
						{ method: 'updateReview', id: 101 },
					])
					expect(fixture.fake.writes).toHaveLength(1)
					expect(fixture.fake.reviews[0]?.state).toBe(state)
				})
		)
	test.effect(
		'offline with no editable review comments and leaves an earlier identity change request in place',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					summaryReview(SUMMARY_MARKER, { state: 'CHANGES_REQUESTED' })
				)
				expect(
					yield* SummaryReviewService.use(service =>
						service.publishStatus({
							pullNumber: 17,
							head: 'head',
							engineCommit: 'engine',
							status: 'offline',
						})
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({ created: true })
				expect(fixture.fake.writes[0]).toMatchObject({
					method: 'review',
					input: { event: 'COMMENT' },
				})
				expect(
					fixture.fake.writes.filter(write => write.method === 'dismissReview')
				).toEqual([])
				expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'offline on a pull request the bot opened comments under its standing change request',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.command.pullRequest = {
					...fixture.fake.command.pullRequest,
					user: { login: APP_IDENTITY.restLogin },
				}
				fixture.fake.reviews.push(
					own({ state: 'CHANGES_REQUESTED', isMinimized: true })
				)
				expect(
					yield* SummaryReviewService.use(service =>
						service.publishStatus({
							pullNumber: 17,
							head: 'reviewed-head',
							engineCommit: 'engine',
							status: 'offline',
						})
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({ created: true, event: 'COMMENT' })
				expect(fixture.fake.writes[0]).toMatchObject({
					method: 'review',
					input: { event: 'COMMENT' },
				})
				expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect('a failed review write leaves change requests untouched', () =>
		Effect.gen(function* () {
			const fixture = setup()
			fixture.fake.reviews.push(own({ state: 'CHANGES_REQUESTED' }))
			const failure = new GitHubApiError({
				operation: 'createReview',
				reason: 'Denied',
				status: 403,
			})
			fixture.fake.failures.review.push(failure)
			expect(
				yield* SummaryReviewService.use(service =>
					service.write(17, draft('COMMENT'))
				).pipe(Effect.provide(fixture.service), Effect.flip)
			).toBe(failure)
			expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
			expect(
				fixture.fake.writes.filter(write => write.method === 'dismissReview')
			).toEqual([])
		})
	)
	test.effect('the dismissal reason names the reviewed head', () =>
		Effect.gen(function* () {
			const fixture = setup()
			fixture.fake.reviews.push(own({ state: 'CHANGES_REQUESTED' }))
			yield* SummaryReviewService.use(service =>
				service.write(17, draft('COMMENT'))
			).pipe(Effect.provide(fixture.service))
			const dismissals = fixture.fake.writes.filter(
				write => write.method === 'dismissReview'
			)
			expect(dismissals).toHaveLength(1)
			expect(dismissals[0]?.body).toContain('reviewed-head')
		})
	)
})

layer(APP_MODE_OWNED)('SummaryReviewService commit ownership', test => {
	for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'] as const)
		for (const commit of ['older-head', undefined])
			test.effect(
				`offline ${state} with commit=${commit} ${state === 'COMMENTED' ? 'edits' : 'posts a new review'}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.reviews.push(
							own({
								state,
								commit: commit === undefined ? undefined : { oid: commit },
							})
						)
						expect(
							yield* SummaryReviewService.use(service =>
								service.publishStatus({
									pullNumber: 17,
									head: 'reviewed-head',
									engineCommit: 'engine',
									status: 'offline',
								})
							).pipe(Effect.provide(fixture.service))
						).toMatchObject({
							created: state !== 'COMMENTED',
							// An offline run has no evidence for a change request, so a new review comments.
							event: 'COMMENT',
							dismissal: { dismissed: state === 'APPROVED' ? 1 : 0, failed: 0 },
						})
						expect(fixture.fake.writes[0]).toMatchObject(
							state === 'COMMENTED'
								? { method: 'updateReview', id: 101 }
								: { method: 'review', input: { commitId: 'reviewed-head' } }
						)
						expect(fixture.fake.reviews[0]?.state).toBe(
							state === 'APPROVED' ? 'DISMISSED' : state
						)
						expect(fixture.fake.reviewCommitReads).toEqual([true])
					})
			)
	for (const event of [
		'APPROVE',
		'COMMENT',
		'REQUEST_CHANGES',
		undefined,
	] as const)
		test.effect(
			`after ${event} a previous identity approval is dismissed even on the same head`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(
						own({
							databaseId: 101,
							id: 'old-own',
							state: 'APPROVED',
							commit: { oid: 'older-head' },
						}),
						own({ databaseId: 102, id: 'same-own', state: 'APPROVED' }),
						summaryReview(SUMMARY_MARKER, {
							databaseId: 103,
							id: 'previous',
							state: 'APPROVED',
							commit: { oid: 'reviewed-head' },
						}),
						own({
							databaseId: 104,
							id: 'foreign',
							state: 'APPROVED',
							commit: { oid: 'older-head' },
							author: { __typename: 'Bot', login: 'foreign' },
						}),
						own({ databaseId: 105, id: 'latest' })
					)
					const written = yield* SummaryReviewService.use(service =>
						service.write(17, draft(event))
					).pipe(Effect.provide(fixture.service))
					const ids = event === 'APPROVE' ? [103] : [101, 103]
					expect(
						fixture.fake.writes
							.filter(write => write.method === 'dismissReview')
							.map(write => write.id)
					).toEqual(ids)
					expect(written.dismissal).toEqual({
						dismissed: ids.length,
						failed: 0,
					})
					expect(
						fixture.fake.reviews.find(review => review.databaseId === 102)
							?.state
					).toBe('APPROVED')
					expect(
						fixture.fake.reviews.find(review => review.databaseId === 104)
							?.state
					).toBe('APPROVED')
				})
		)
	for (const event of ['APPROVE', 'COMMENT'] as const)
		test.effect(
			`after ${event} a previous identity approval on the head is dismissed as replaced, never as unapproved`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(
						own({
							databaseId: 101,
							id: 'old-own',
							state: 'APPROVED',
							commit: { oid: 'older-head' },
						}),
						summaryReview(SUMMARY_MARKER, {
							databaseId: 103,
							id: 'previous',
							state: 'APPROVED',
							commit: { oid: 'reviewed-head' },
						}),
						own({ databaseId: 105, id: 'latest' })
					)
					yield* SummaryReviewService.use(service =>
						service.write(17, draft(event))
					).pipe(Effect.provide(fixture.service))
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'dismissReview'
						)
					).toEqual([
						...(event === 'APPROVE'
							? []
							: [
									{
										method: 'dismissReview',
										id: 101,
										body: toStaleApprovalMessage('reviewed-head'),
									},
								]),
						{
							method: 'dismissReview',
							id: 103,
							body: toReplacedApprovalMessage('reviewed-head'),
						},
					])
				})
		)
	test.effect(
		'offline status-only counts a refused stale-approval dismissal and keeps the change request',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					own({
						id: 'approval',
						databaseId: 100,
						state: 'APPROVED',
						commit: { oid: 'older-head' },
					}),
					own({ state: 'CHANGES_REQUESTED' })
				)
				fixture.fake.failures.dismissReview.push(
					new GitHubApiError({
						operation: 'dismissReview',
						reason: 'Denied',
						status: 403,
					})
				)
				expect(
					yield* SummaryReviewService.use(service =>
						service.publishStatus({
							pullNumber: 17,
							head: 'reviewed-head',
							engineCommit: 'engine',
							status: 'offline',
						})
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({
					created: false,
					event: 'REQUEST_CHANGES',
					dismissal: { dismissed: 0, failed: 1 },
				})
				expect(
					fixture.fake.writes
						.filter(write => write.method === 'dismissReview')
						.map(write => write.id)
				).toEqual([100])
				expect(fixture.fake.reviews[1]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'readPrior, readWaiting and reservation do not request review commits',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					own({ state: 'APPROVED', commit: { oid: 'older-head' } })
				)
				const service = yield* SummaryReviewService.pipe(
					Effect.provide(fixture.service)
				)
				expect(yield* service.readPrior(17)).toEqual(SUMMARY_MARKER)
				expect(yield* service.readWaiting(17)).toEqual([])
				expect(
					yield* service.reserveManualRun({
						pullNumber: 17,
						head: 'reviewed-head',
						engineCommit: 'engine',
						handle: 'mng-review',
						maxRuns: 10,
					})
				).toBeTruthy()
				expect(fixture.fake.reviewCommitReads).toEqual([
					false,
					undefined,
					false,
				])
				expect(fixture.fake.writes.map(write => write.method)).toEqual([
					'updateReview',
				])
				expect(fixture.fake.reviews[0]?.commit?.oid).toBe('older-head')
				expect(fixture.fake.reviews[0]?.state).toBe('APPROVED')
			})
	)
	for (const changesRequested of [false, true])
		test.effect(
			`new threads on a run without evidence post a comment, changesRequested=${changesRequested}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(
						own({ state: changesRequested ? 'CHANGES_REQUESTED' : 'COMMENTED' })
					)
					expect(
						yield* SummaryReviewService.use(service =>
							service.write(17, {
								...draft(),
								comments: [{ path: 'src/store.ts', line: 10, body: 'Finding' }],
							})
						).pipe(Effect.provide(fixture.service))
					).toMatchObject({
						created: true,
						event: 'COMMENT',
						dismissal: { dismissed: 0, failed: 0 },
					})
					expect(fixture.fake.reviews[0]?.state).toBe(
						changesRequested ? 'CHANGES_REQUESTED' : 'COMMENTED'
					)
					expect(fixture.fake.writes[0]).toMatchObject({
						method: 'review',
						input: {
							event: 'COMMENT',
							comments: [{ line: 10 }],
						},
					})
				})
		)
	for (const event of ['APPROVE', 'REQUEST_CHANGES'] as const)
		test.effect(
			`matching ${event} on an older commit still posts a new review`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(
						own({
							state: REVIEW_STATE_BY_EVENT[event],
							commit: { oid: 'older-head' },
						})
					)
					expect(
						yield* SummaryReviewService.use(service =>
							service.write(17, draft(event))
						).pipe(Effect.provide(fixture.service))
					).toMatchObject({ created: true, event })
					expect(fixture.fake.writes[0]).toMatchObject({
						method: 'review',
						input: { event, commitId: 'reviewed-head' },
					})
					expect(
						fixture.fake.writes.filter(write => write.method === 'updateReview')
					).toEqual([])
				})
		)
	for (const event of REVIEW_EVENTS)
		test.effect(`a new ${event} review opens with the state it carries`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				const written = yield* SummaryReviewService.use(service =>
					service.write(17, draft(event))
				).pipe(Effect.provide(fixture.service))
				const label = {
					APPROVE: '**Approved.**',
					REQUEST_CHANGES: '**Changes requested.**',
					COMMENT: '**Comment.**',
				}[event]
				expect(written.body.startsWith(label)).toBeTruthy()
				expect(fixture.fake.writes[0]).toMatchObject({
					method: 'review',
					input: { event, body: written.body },
				})
				expect(written.body.includes('Not approved:')).toBe(event !== 'APPROVE')
			})
		)
	for (const event of REVIEW_EVENTS)
		test.effect(
			`a push after the write ${event === 'COMMENT' ? 'leaves' : 'dismisses'} the ${event} review it just posted`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const pr = fixture.fake.command.pullRequest
					const next = { ...pr, head: { ...pr.head, sha: 'next-head' } }
					// Before the review, then after it: before the cleanup and before the dismissals.
					fixture.fake.pullRequestSnapshots.push(pr, next, next)
					const verdict = event !== 'COMMENT'
					expect(
						yield* SummaryReviewService.use(service =>
							service.write(17, draft(event))
						).pipe(Effect.provide(fixture.service))
					).toMatchObject({
						created: true,
						dismissal: { dismissed: verdict ? 1 : 0, failed: 0 },
						outlived: verdict,
					})
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'dismissReview'
						)
					).toEqual(
						verdict
							? [
									{
										method: 'dismissReview',
										id: 1,
										body: toOutlivedReviewMessage('next-head'),
									},
								]
							: []
					)
					expect(fixture.fake.reviews[0]?.state).toBe(
						verdict ? 'DISMISSED' : 'COMMENTED'
					)
				})
		)
	for (const event of ['APPROVE', 'REQUEST_CHANGES'] as const)
		test.effect(
			`a push after the write ${event === 'APPROVE' ? 'dismisses once' : 'leaves'} the ${event} review it only edited`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(
						own({ state: REVIEW_STATE_BY_EVENT[event] })
					)
					const pr = fixture.fake.command.pullRequest
					const next = { ...pr, head: { ...pr.head, sha: 'next-head' } }
					// Before the review, then after it: before the cleanup and before the dismissals.
					fixture.fake.pullRequestSnapshots.push(pr, next, next)
					const approve = event === 'APPROVE'
					expect(
						yield* SummaryReviewService.use(service =>
							service.write(17, draft(event))
						).pipe(Effect.provide(fixture.service))
					).toMatchObject({
						created: false,
						dismissal: { dismissed: approve ? 1 : 0, failed: 0 },
						outlived: approve,
					})
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'dismissReview'
						)
					).toEqual(
						approve
							? [
									{
										method: 'dismissReview',
										id: 101,
										body: toOutlivedReviewMessage('next-head'),
									},
								]
							: []
					)
				})
		)
	test.effect(
		'with the second head read failing, a verdict review on another commit stays visible',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					own({
						databaseId: 100,
						id: 'next-approval',
						state: 'APPROVED',
						commit: { oid: 'next-head' },
					}),
					own({ databaseId: 101, id: 'comment' })
				)
				fixture.fake.failures.getPullRequest.push(
					undefined,
					new GitHubApiError({
						operation: 'getPullRequest',
						reason: 'Unavailable',
						status: 503,
					})
				)
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, draft('APPROVE'))
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({ event: 'APPROVE' })
				expect(
					fixture.fake.writes.filter(write => write.method === 'minimize')
				).toEqual([{ method: 'minimize', id: 'comment' }])
			})
	)
	test.effect(
		"a run on an older head leaves the previous identity's approval of the current head",
		() =>
			Effect.gen(function* () {
				const fixture = setup('next-head')
				fixture.fake.reviews.push(
					summaryReview(SUMMARY_MARKER, {
						databaseId: 103,
						id: 'previous-on-head',
						state: 'APPROVED',
						commit: { oid: 'next-head' },
					}),
					summaryReview(SUMMARY_MARKER, {
						databaseId: 104,
						id: 'previous-older',
						state: 'APPROVED',
						commit: { oid: 'older-head' },
					}),
					own({ databaseId: 105, id: 'latest' })
				)
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, draft('COMMENT'))
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({ dismissal: { dismissed: 1, failed: 0 } })
				expect(
					fixture.fake.writes
						.filter(write => write.method === 'dismissReview')
						.map(write => write.id)
				).toEqual([104])
				expect(fixture.fake.reviews[0]?.state).toBe('APPROVED')
			})
	)
	test.effect(
		'an offline edit of a change request on its head is headed by that state and replaces the old headline',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					own({
						state: 'CHANGES_REQUESTED',
						body: `**Comment.** Not approved: stale.\n\n${toMarkerComment('summary', SUMMARY_MARKER)}`,
					})
				)
				yield* SummaryReviewService.use(service =>
					service.publishStatus({
						pullNumber: 17,
						head: 'reviewed-head',
						engineCommit: 'engine',
						status: 'offline',
					})
				).pipe(Effect.provide(fixture.service))
				const body = fixture.fake.reviews[0]?.body ?? ''
				expect(body).toMatch(
					/^\*\*Changes requested\.\*\* Not approved: the reviewer was offline/u
				)
				expect(body).not.toContain('stale.')
				expect(body.match(/Not approved:/gu)).toHaveLength(1)
			})
	)
})
