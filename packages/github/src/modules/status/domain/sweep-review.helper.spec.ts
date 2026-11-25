import { APP_IDENTITY } from '../../../shared/mocks/publish-test.helper'
import {
	getSweptFinished,
	getUnbackedRequests,
	getUnthreadedBugs,
	isConfirmDue,
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
