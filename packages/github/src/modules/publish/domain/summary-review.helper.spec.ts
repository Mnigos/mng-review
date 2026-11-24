import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import type { PullRequestReview } from '../../../platform/github-api.schema'
import {
	APP_IDENTITY,
	APP_MODE_IDENTITIES,
	appSummary,
	SUMMARY_MARKER,
	summaryReview,
} from '../../../shared/mocks/publish-test.helper'
import { getListedWaiting, toSummaryComments } from './summary-comment.helper'
import {
	getEditableReview,
	getPriorSummary,
	getStaleReviews,
	toSummaryReviews,
} from './summary-review.helper'

const COMMENT = { event: 'COMMENT', keep: false } as const
const ON_HEAD = { head: 'head', current: 'head' } as const
const APPROVE = { event: 'APPROVE', keep: false } as const

/** Projects review fixtures using the app and its previous job-token identity. */
function summaries(reviews: readonly PullRequestReview[]) {
	return toSummaryReviews(reviews, APP_MODE_IDENTITIES, APP_IDENTITY)
}

describe('summary reviews', () => {
	test('retains order and hidden or dismissed review markers across owned identities', () => {
		const reviews = summaries([
			summaryReview(SUMMARY_MARKER, { isMinimized: true }),
			summaryReview(
				{ ...SUMMARY_MARKER, runs: 4 },
				{
					databaseId: 102,
					state: 'DISMISSED',
					author: { __typename: 'Bot', login: APP_IDENTITY.login },
				}
			),
		])
		expect(reviews).toMatchObject([
			{ id: 101, mine: false, minimized: true, marker: SUMMARY_MARKER },
			{ id: 102, mine: true, state: 'DISMISSED', marker: { runs: 4 } },
		])
		expect(getPriorSummary(reviews, [])).toBe(reviews[1])
	})
	const invalid = [
		{ databaseId: null },
		{ author: null },
		{ author: { __typename: 'User', login: APP_IDENTITY.login } },
		{ author: { __typename: 'Bot', login: 'foreign' } },
		{ editor: { __typename: 'User', login: 'writer' } },
		{ editor: { __typename: 'Bot', login: APP_IDENTITY.login } },
		{ body: 'No marker' },
	] as const satisfies readonly Partial<PullRequestReview>[]
	for (const [index, overrides] of invalid.entries())
		test(`rejects untrusted or unusable summary review ${index}`, () => {
			expect(summaries([summaryReview(SUMMARY_MARKER, overrides)])).toEqual([])
		})
	test('accepts an owned review edited by its own author', () => {
		expect(
			summaries([
				summaryReview(SUMMARY_MARKER, {
					editor: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
				}),
			])
		).toHaveLength(1)
	})
	test('prior prefers the latest review over current-identity legacy comments', () => {
		const reviews = summaries([summaryReview()])
		const comments = toSummaryComments(
			[appSummary({ ...SUMMARY_MARKER, runs: 20 })],
			APP_MODE_IDENTITIES,
			APP_IDENTITY
		)
		expect(getPriorSummary(reviews, comments)).toBe(reviews[0])
		expect(getPriorSummary([], comments)).toBe(comments[0])
		expect(getPriorSummary([], [])).toBeUndefined()
	})
	test('only the latest summary can be edited and all edit conditions must hold', () => {
		const own = summaryReview(SUMMARY_MARKER, {
			author: { __typename: 'Bot', login: APP_IDENTITY.login },
		})
		const reviews = summaries([own])
		expect(getEditableReview(reviews, COMMENT, false, ON_HEAD)).toBe(reviews[0])
		expect(getEditableReview(reviews, COMMENT, true, ON_HEAD)).toBeUndefined()
		expect(getEditableReview(reviews, APPROVE, false, ON_HEAD)).toBeUndefined()
		expect(
			getEditableReview(
				summaries([own, summaryReview()]),
				COMMENT,
				false,
				ON_HEAD
			)
		).toBeUndefined()
		expect(
			getEditableReview(
				summaries([{ ...own, isMinimized: true }]),
				COMMENT,
				false,
				ON_HEAD
			)
		).toBeUndefined()
		expect(getEditableReview([], COMMENT, false, ON_HEAD)).toBeUndefined()
	})
	test('stale reviews include old unmarked bodies but exclude hidden, edited, foreign, empty and kept reviews', () => {
		const old = summaryReview(SUMMARY_MARKER, {
			databaseId: 1,
			body: '2 new comments',
		})
		const other = summaryReview(SUMMARY_MARKER, {
			databaseId: 2,
			author: { __typename: 'Bot', login: APP_IDENTITY.login },
		})
		const kept = summaryReview(SUMMARY_MARKER, { databaseId: 3 })
		const excluded = [
			{ isMinimized: true },
			{ body: ' \n ' },
			{ author: null },
			{ author: { __typename: 'Bot', login: 'foreign' } },
			{ editor: { __typename: 'User', login: 'writer' } },
		] as const satisfies readonly Partial<PullRequestReview>[]
		expect(
			getStaleReviews(
				[
					old,
					other,
					kept,
					...excluded.map(overrides =>
						summaryReview(SUMMARY_MARKER, overrides)
					),
				],
				APP_MODE_IDENTITIES,
				3
			)
		).toEqual([old, other])
	})
	test('waiting ids include hidden reviews and comments across identities without duplicates', () => {
		expect(
			getListedWaiting(
				[
					summaryReview(
						{ ...SUMMARY_MARKER, needsOwner: ['old', 'shared'] },
						{ isMinimized: true, state: 'DISMISSED' }
					),
					appSummary(
						{ ...SUMMARY_MARKER, needsOwner: ['new', 'shared'] },
						{ isMinimized: true }
					),
				],
				APP_MODE_IDENTITIES
			)
		).toEqual(['old', 'shared', 'new'])
	})
})
