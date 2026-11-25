import {
	APP_IDENTITY,
	summaryReview,
} from '../../../shared/mocks/publish-test.helper'
import { toSummaryReviews } from '../../publish/domain/summary-review.helper'
import {
	getConfirmedSummary,
	getConfirmedWaiting,
	getSweptFinished,
	getUnbackedRequests,
	getUnthreadedBugs,
	isConfirmDue,
	isPlanTurned,
	isSweptUnfinished,
	toConfirmedStatus,
} from './sweep-review.helper'

const REQUEST = {
	id: 'request',
	databaseId: 7,
	state: 'CHANGES_REQUESTED',
	isMinimized: false,
	body: 'Changes requested',
	author: { __typename: 'Bot', login: APP_IDENTITY.login },
	editor: null,
	commit: { oid: 'head' },
} as const
const ON_HEAD = { v: 1, runs: 2, head: 'head', finished: true } as const
const INCOMPLETE = { ...ON_HEAD, finished: false, failed: true } as const

describe('getUnbackedRequests', () => {
	test('lifts the request nothing backs on the marker head', () => {
		expect(
			getUnbackedRequests([REQUEST], APP_IDENTITY, 'head', ON_HEAD, true)
		).toEqual([7])
	})
	test('lifts nothing while the marker is one an incomplete write left', () => {
		expect(
			getUnbackedRequests([REQUEST], APP_IDENTITY, 'head', INCOMPLETE, true)
		).toEqual([])
	})
})

describe('getSweptFinished', () => {
	test.each([
		['an own finished marker on the head', true, ON_HEAD, true],
		['an own marker on another head', true, { ...ON_HEAD, head: 'old' }, false],
		[
			"another identity's marker on another head",
			false,
			{ ...ON_HEAD, head: 'old' },
			undefined,
		],
		['an own incomplete marker', true, INCOMPLETE, false],
		[
			"another identity's incomplete marker on another head",
			false,
			{ ...INCOMPLETE, head: 'old' },
			false,
		],
	] as const)('%s gives %s', (_name, mine, marker, finished) => {
		expect(getSweptFinished({ mine, marker }, 'head')).toBe(finished)
	})
})

describe('isSweptUnfinished', () => {
	const author = { __typename: 'Bot', login: APP_IDENTITY.login } as const
	const swept = {
		summaries: [],
		owned: [APP_IDENTITY],
		current: APP_IDENTITY,
	} as const
	const judged = (marker: typeof ON_HEAD | typeof INCOMPLETE) =>
		toSummaryReviews(
			[summaryReview(marker, { author })],
			[APP_IDENTITY],
			APP_IDENTITY
		)[0]
	test.each([
		['an incomplete judged marker', INCOMPLETE, undefined, true],
		['a finished marker without a confirming read', ON_HEAD, undefined, false],
		[
			'a finished marker the confirming read keeps newest',
			ON_HEAD,
			[summaryReview(ON_HEAD, { author })],
			false,
		],
		[
			'a newer incomplete marker in the confirming read',
			ON_HEAD,
			[
				summaryReview(ON_HEAD, { author }),
				summaryReview(INCOMPLETE, { author, databaseId: 102 }),
			],
			true,
		],
	] as const)('%s gives %s', (_name, marker, latest, unfinished) => {
		expect(
			isSweptUnfinished({ ...swept, summary: judged(marker), latest })
		).toBe(unfinished)
	})
	test('decides from the newest summary of the confirming read', () => {
		const newer = { ...ON_HEAD, runs: 3, unthreadedBugs: 1 } as const
		const latest = [
			summaryReview(ON_HEAD, { author }),
			summaryReview(newer, { author, databaseId: 102 }),
		]
		expect(
			getConfirmedSummary({ ...swept, summary: judged(ON_HEAD), latest })
				?.marker
		).toEqual(newer)
		expect(
			getConfirmedSummary({
				...swept,
				summary: judged(ON_HEAD),
				latest: undefined,
			})?.marker
		).toEqual(ON_HEAD)
	})
})

describe('getUnthreadedBugs', () => {
	test('counts the bugs without a thread on the marker head only', () => {
		const marker = { ...ON_HEAD, unthreadedBugs: 2 } as const
		expect(getUnthreadedBugs(marker, 'head')).toBe(2)
		expect(getUnthreadedBugs(marker, 'other')).toBe(0)
		expect(getUnthreadedBugs(undefined, 'head')).toBe(0)
	})
})

describe('isConfirmDue', () => {
	test('reads again before a dismissal or a success only', () => {
		expect(isConfirmDue([102], undefined)).toBeTruthy()
		expect(isConfirmDue([], { state: 'success' })).toBeTruthy()
		expect(isConfirmDue([], { state: 'error' })).toBeFalsy()
		expect(isConfirmDue([], undefined)).toBeFalsy()
	})
})

describe('getConfirmedWaiting', () => {
	const first = { id: 101, body: 'first', marker: ON_HEAD } as const
	const waiting = { ...ON_HEAD, needsOwner: ['thread'] } as const
	test('takes the waits of a summary a run wrote between the reads', () => {
		expect(
			getConfirmedWaiting(first, { id: 103, body: 'newer', marker: waiting })
		).toEqual(['thread'])
		expect(
			getConfirmedWaiting(first, { ...first, body: 'edited', marker: waiting })
		).toEqual(['thread'])
	})
	test('takes none from the summary the sweep judged first', () => {
		expect(getConfirmedWaiting(first, { ...first, marker: waiting })).toEqual(
			[]
		)
		expect(getConfirmedWaiting(first, undefined)).toEqual([])
	})
})

describe('toConfirmedStatus', () => {
	const success = {
		state: 'success',
		description: 'no open bug thread',
	} as const
	const failure = {
		state: 'failure',
		description: '1 open bug thread(s)',
	} as const
	test('keeps a success the sweep planned and a read backed', () => {
		expect(toConfirmedStatus(success, success, false)).toEqual(success)
	})
	test('never raises a plan to success', () => {
		expect(toConfirmedStatus(failure, success, false)).toBeUndefined()
		expect(toConfirmedStatus(undefined, success, false)).toBeUndefined()
	})
	test('writes no success after a failed read', () => {
		expect(toConfirmedStatus(success, success, true)).toBeUndefined()
	})
	test('lowers a planned success', () => {
		expect(toConfirmedStatus(success, failure, false)).toEqual(failure)
	})
})

describe('isPlanTurned', () => {
	test('turns when the read holds back or would raise a success', () => {
		expect(
			isPlanTurned({ state: 'success' }, { state: 'failure' })
		).toBeTruthy()
		expect(isPlanTurned({ state: 'error' }, { state: 'success' })).toBeTruthy()
		expect(isPlanTurned(undefined, { state: 'success' })).toBeTruthy()
	})
	test('stays when both read alike', () => {
		expect(isPlanTurned({ state: 'success' }, { state: 'success' })).toBeFalsy()
		expect(isPlanTurned({ state: 'error' }, { state: 'failure' })).toBeFalsy()
		expect(isPlanTurned(undefined, undefined)).toBeFalsy()
	})
})
