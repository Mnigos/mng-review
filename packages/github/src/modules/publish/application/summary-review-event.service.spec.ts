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
	summaryReview,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import {
	SummaryReviewService,
	SummaryReviewServiceLive,
} from './summary-review.service'
import type {
	SummaryDraft,
	SummaryRender,
} from './summary-review.service.types'

/** A marked body with an explicit event, or no new judgement for offline writes. */
function draft(event?: ReviewEvent): SummaryDraft {
	return {
		head: 'reviewed-head',
		render: () => ({
			body: toMarkerComment('summary', SUMMARY_MARKER),
			marker: SUMMARY_MARKER,
			...(event === undefined ? {} : { event }),
		}),
	}
}

/** Records review writes and failures without an HTTP client. */
function setup() {
	const fake = githubApiFake(APP_IDENTITY)
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
				expect(written).toMatchObject({ event, created: false, dismissed: 0 })
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
					expect(written.dismissed).toBe(ids.length)
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
				).toMatchObject({ dismissed: 1, event: 'COMMENT' })
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
				).toMatchObject({ dismissed: 1 })
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
				const fixture = setup()
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
					event,
				}))
				const written = yield* SummaryReviewService.use(service =>
					service.write(17, {
						head: 'head',
						comments: [{ path: 'src/example.ts', line: 7, body: 'Finding' }],
						render: renderSpy,
					})
				).pipe(Effect.provide(fixture.service))
				expect(written).toMatchObject({
					event,
					inline: false,
					body: 'Fallback body',
				})
				expect(
					fixture.fake.writes.filter(write => write.method === 'review')
				).toMatchObject([
					{ input: { event, body: 'Inline body', comments: [{ line: 7 }] } },
					{ input: { event, body: 'Fallback body', comments: [] } },
				])
				expect(renderSpy).toHaveBeenCalledTimes(2)
			})
		)
	test.effect(
		'422 fallback uses the new event returned by the second render',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
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
							event: inline ? 'REQUEST_CHANGES' : 'COMMENT',
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
								head: 'head',
								engineCommit: 'engine',
								status: 'offline',
							})
						).pipe(Effect.provide(fixture.service))
					).toBe(false)
					expect(fixture.fake.writes).toMatchObject([
						{ method: 'updateReview', id: 101 },
					])
					expect(fixture.fake.writes).toHaveLength(1)
					expect(fixture.fake.reviews[0]?.state).toBe(state)
				})
		)
	test.effect(
		'offline with no editable review posts COMMENT and leaves old change requests in place',
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
				).toBe(true)
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
