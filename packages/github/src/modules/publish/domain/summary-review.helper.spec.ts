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
	hasChangeRequest,
	getStaleApprovals,
	getStaleChangeRequests,
	toSummaryReviews,
} from './summary-review.helper'

const COMMENT = { event: 'COMMENT', keep: false } as const
const ON_HEAD = { head: 'head', current: 'head' } as const
const APPROVE = { event: 'APPROVE', keep: false } as const

/** Projects review fixtures using the app and its previous job-token identity. */
function summaries(reviews: readonly PullRequestReview[]) {
	return toSummaryReviews(reviews, APP_MODE_IDENTITIES, APP_IDENTITY)
}

describe('standing change requests', () => {
	const own = { __typename: 'Bot', login: APP_IDENTITY.login } as const
	test('an approval after a change request of the same identity supersedes it', () => {
		expect(
			hasChangeRequest(
				[
					summaryReview(SUMMARY_MARKER, {
						databaseId: 1,
						state: 'CHANGES_REQUESTED',
						author: own,
					}),
					summaryReview(SUMMARY_MARKER, {
						databaseId: 2,
						state: 'APPROVED',
						author: own,
					}),
				],
				APP_MODE_IDENTITIES
			)
		).toBe(false)
	})
	test('a change request after an approval stands', () => {
		expect(
			hasChangeRequest(
				[
					summaryReview(SUMMARY_MARKER, { state: 'APPROVED', author: own }),
					summaryReview(SUMMARY_MARKER, {
						state: 'CHANGES_REQUESTED',
						author: own,
					}),
				],
				APP_MODE_IDENTITIES
			)
		).toBe(true)
	})
	test('a later comment leaves a change request standing, a dismissal does not', () => {
		const request = summaryReview(SUMMARY_MARKER, {
			state: 'CHANGES_REQUESTED',
			author: own,
		})
		const comment = summaryReview(SUMMARY_MARKER, { author: own })
		expect(hasChangeRequest([request, comment], APP_MODE_IDENTITIES)).toBe(true)
		expect(
			hasChangeRequest(
				[{ ...request, state: 'DISMISSED' }, comment],
				APP_MODE_IDENTITIES
			)
		).toBe(false)
	})
	test("another owned identity's approval does not supersede a change request", () => {
		expect(
			hasChangeRequest(
				[
					summaryReview(SUMMARY_MARKER, {
						state: 'CHANGES_REQUESTED',
						author: own,
					}),
					summaryReview(SUMMARY_MARKER, { state: 'APPROVED' }),
				],
				APP_MODE_IDENTITIES
			)
		).toBe(true)
	})
})

describe('reviews on the current head', () => {
	const own = { __typename: 'Bot', login: APP_IDENTITY.login } as const
	for (const state of ['APPROVED', 'CHANGES_REQUESTED'] as const) {
		const reviews = summaries([
			summaryReview(SUMMARY_MARKER, {
				state,
				author: own,
				commit: { oid: 'head' },
			}),
		])
		const keep = { event: 'COMMENT', keep: true } as const
		test(`a run on another head never edits ${state} on the current head`, () => {
			expect(
				getEditableReview(reviews, keep, false, {
					head: 'older-head',
					current: 'head',
				})
			).toBeUndefined()
		})
		test(`an unread current head never edits ${state}`, () => {
			expect(
				getEditableReview(reviews, keep, false, {
					head: 'head',
					current: undefined,
				})
			).toBeUndefined()
		})
		test(`a run on ${state}'s commit while it is the head edits it`, () => {
			expect(getEditableReview(reviews, keep, false, ON_HEAD)).toBe(reviews[0])
		})
	}
	test('a comment review is edited by a run on another head', () => {
		const reviews = summaries([summaryReview(SUMMARY_MARKER, { author: own })])
		expect(
			getEditableReview(reviews, { event: 'COMMENT', keep: true }, false, {
				head: 'older-head',
				current: 'head',
			})
		).toBe(reviews[0])
	})
	const approvals = [
		summaryReview(SUMMARY_MARKER, {
			databaseId: 1,
			state: 'APPROVED',
			author: own,
			commit: { oid: 'head' },
		}),
		summaryReview(SUMMARY_MARKER, {
			databaseId: 2,
			state: 'APPROVED',
			author: own,
			commit: { oid: 'older-head' },
		}),
	]
	const comment = { state: 'COMMENTED', commit: 'older-head' } as const
	const previous = [
		summaryReview(SUMMARY_MARKER, {
			databaseId: 3,
			state: 'APPROVED',
			commit: { oid: 'head' },
		}),
		summaryReview(SUMMARY_MARKER, {
			databaseId: 4,
			state: 'APPROVED',
			commit: { oid: 'older-head' },
		}),
	]
	const OLDER_RUN = { head: 'older-head', current: 'head' } as const
	const UNREAD = { head: 'head', current: undefined } as const
	test('an approval on the current head outlives a write by a run on an older head', () => {
		expect(
			getStaleApprovals(
				approvals,
				APP_MODE_IDENTITIES,
				APP_IDENTITY,
				OLDER_RUN,
				comment
			)
		).toEqual([2])
	})
	test('with no current head read, no approval of the current identity is dismissed', () => {
		expect(
			getStaleApprovals(
				approvals,
				APP_MODE_IDENTITIES,
				APP_IDENTITY,
				UNREAD,
				comment
			)
		).toEqual([])
	})
	test("a run on an older head leaves another identity's approval on the current head", () => {
		expect(
			getStaleApprovals(
				[...approvals, ...previous],
				APP_MODE_IDENTITIES,
				APP_IDENTITY,
				OLDER_RUN,
				comment
			)
		).toEqual([2, 4])
	})
	test('with no current head read, no approval of another identity is dismissed', () => {
		expect(
			getStaleApprovals(
				previous,
				APP_MODE_IDENTITIES,
				APP_IDENTITY,
				UNREAD,
				comment
			)
		).toEqual([])
	})
	test('a write on the current head dismisses every approval of another identity', () => {
		expect(
			getStaleApprovals(
				[...approvals, ...previous],
				APP_MODE_IDENTITIES,
				APP_IDENTITY,
				ON_HEAD,
				{ state: 'COMMENTED', commit: 'head' }
			)
		).toEqual([2, 3, 4])
	})
	test('a run on an older head leaves a verdict review on the current head visible', () => {
		expect(
			getStaleReviews(approvals, APP_MODE_IDENTITIES, undefined, OLDER_RUN).map(
				review => review.databaseId
			)
		).toEqual([2])
	})
	test('with no current head read, every verdict review stays visible', () => {
		expect(
			getStaleReviews(
				[
					...approvals,
					summaryReview(SUMMARY_MARKER, { databaseId: 5, author: own }),
				],
				APP_MODE_IDENTITIES,
				undefined,
				UNREAD
			).map(review => review.databaseId)
		).toEqual([5])
	})
})

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

for (const state of [
	'COMMENTED',
	'APPROVED',
	'CHANGES_REQUESTED',
	'DISMISSED',
] as const)
	test(`a raw owned ${state} review without a summary marker carries only its actual change request`, () => {
		const review = summaryReview(SUMMARY_MARKER, {
			state,
			body: 'A standalone review',
			isMinimized: true,
		})
		expect(hasChangeRequest([review], APP_MODE_IDENTITIES)).toBe(
			state === 'CHANGES_REQUESTED'
		)
		expect(
			getStaleChangeRequests([review], APP_MODE_IDENTITIES, APP_IDENTITY, {
				event: 'COMMENT',
				clears: true,
			})
		).toEqual(state === 'CHANGES_REQUESTED' ? [review.databaseId] : [])
	})

test('a foreign change request does not make the bot preserve a blocking state', () => {
	expect(
		hasChangeRequest(
			[
				summaryReview(SUMMARY_MARKER, {
					state: 'CHANGES_REQUESTED',
					author: { __typename: 'Bot', login: 'foreign' },
				}),
			],
			APP_MODE_IDENTITIES
		)
	).toBe(false)
})

describe('summary answers from another identity', () => {
	const answers = [
		{
			run: 7,
			kind: 'review',
			ids: [{ id: 42, at: '2026-01-01T12:00:00Z', digest: 'a'.repeat(16) }],
		},
	] as const
	test.each([
		[APP_IDENTITY.login, answers],
		[GITHUB_ACTIONS_IDENTITY.login, undefined],
	])(
		'a summary by %s carries the answers only when the current app wrote it',
		(login, expected) => {
			const marker = { ...SUMMARY_MARKER, answers }
			const author = { __typename: 'Bot', login }
			expect(
				summaries([summaryReview(marker, { author })])[0]?.marker.answers
			).toEqual(expected)
			expect(
				toSummaryComments(
					[appSummary(marker, { author })],
					APP_MODE_IDENTITIES,
					APP_IDENTITY
				)[0]?.marker.answers
			).toEqual(expected)
		}
	)
})
