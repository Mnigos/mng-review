import type { PullRequestReview } from '../../../platform/github-api.schema'
import {
	REVIEW_EVENTS,
	REVIEW_STATE_BY_EVENT,
} from '../../../platform/github-review.service'
import {
	APP_IDENTITY,
	APP_MODE_IDENTITIES,
	summaryReview,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import {
	getEditableReview,
	getStaleChangeRequests,
	toSummaryReviews,
} from './summary-review.helper'

const KEEP = { event: 'COMMENT', keep: true } as const
const ON_HEAD = { head: 'head', current: 'head' } as const

for (const event of REVIEW_EVENTS)
	for (const state of [
		'APPROVED',
		'CHANGES_REQUESTED',
		'COMMENTED',
		'DISMISSED',
		'PENDING',
	] as const)
		test(`${event} edits only state ${REVIEW_STATE_BY_EVENT[event]}, given ${state}`, () => {
			const reviews = toSummaryReviews(
				[
					summaryReview(SUMMARY_MARKER, {
						author: { __typename: 'Bot', login: APP_IDENTITY.login },
						state,
						commit: { oid: 'head' },
					}),
				],
				APP_MODE_IDENTITIES,
				APP_IDENTITY
			)
			expect(
				getEditableReview(reviews, { event, keep: false }, false, ON_HEAD)
			).toBe(state === REVIEW_STATE_BY_EVENT[event] ? reviews[0] : undefined)
			expect(getEditableReview(reviews, KEEP, false, ON_HEAD)).toBe(reviews[0])
			expect(getEditableReview(reviews, KEEP, true, ON_HEAD)).toBeUndefined()
		})

for (const event of [...REVIEW_EVENTS, undefined])
	test(`stale change requests after ${event} respect identity, type, state and database id`, () => {
		const overrides = [
			{
				databaseId: 1,
				author: { __typename: 'Bot', login: APP_IDENTITY.login },
			},
			{ databaseId: 2, isMinimized: true },
			{ databaseId: 3, body: 'Unmarked old request' },
			{ databaseId: 4, state: 'DISMISSED' },
			{ databaseId: 5, state: 'APPROVED' },
			{ databaseId: 6, state: 'COMMENTED' },
			{ databaseId: 7, author: null },
			{ databaseId: 8, author: { __typename: 'Bot', login: 'foreign' } },
			{
				databaseId: 9,
				author: { __typename: 'User', login: APP_IDENTITY.login },
			},
			{ databaseId: null },
		] as const satisfies readonly Partial<PullRequestReview>[]
		expect(
			getStaleChangeRequests(
				overrides.map(override =>
					summaryReview(SUMMARY_MARKER, {
						state: 'CHANGES_REQUESTED',
						...override,
					})
				),
				APP_MODE_IDENTITIES,
				APP_IDENTITY,
				{
					event: event ?? 'COMMENT',
					clears: event === 'COMMENT' || event === 'APPROVE',
				}
			)
		).toEqual(
			event === 'COMMENT' ? [1, 2, 3] : event === 'APPROVE' ? [2, 3] : []
		)
	})

test('offline still rejects hidden reviews and the newest summary of another identity', () => {
	const own = summaryReview(SUMMARY_MARKER, {
		author: { __typename: 'Bot', login: APP_IDENTITY.login },
	})
	expect(
		getEditableReview(
			toSummaryReviews(
				[{ ...own, isMinimized: true }],
				APP_MODE_IDENTITIES,
				APP_IDENTITY
			),
			KEEP,
			false,
			ON_HEAD
		)
	).toBeUndefined()
	expect(
		getEditableReview(
			toSummaryReviews(
				[own, summaryReview()],
				APP_MODE_IDENTITIES,
				APP_IDENTITY
			),
			KEEP,
			false,
			ON_HEAD
		)
	).toBeUndefined()
})
