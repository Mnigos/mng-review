import { MAX_REVIEW_UNITS, type ReviewUnit } from '@mng-review/domain'
import {
	getFirstDiffChars,
	getUnitCount,
	getValidationTokens,
	getUnitsToReview,
	toFinderStatus,
} from './finder-budget.helper'
import {
	CHARS_PER_TOKEN,
	FIRST_MESSAGE_SHARE,
	MIN_FIRST_DIFF_CHARS,
	MIN_UNIT_TOKENS,
	MIN_VALIDATION_TOKENS,
	MAX_VALIDATION_TOKENS,
} from './review.constants'

const UNITS = [
	{ label: 'billing', paths: ['billing.ts'], diff: 'a', size: 1 },
	{ label: 'mixed', paths: ['viewer.ts', 'billing.ts'], diff: 'b', size: 2 },
	{ label: 'viewer', paths: ['viewer.ts'], diff: 'c', size: 1 },
] as const satisfies readonly ReviewUnit[]

describe('finder budgets', () => {
	test('sizes the first diff from its token share and floors fractional characters', () => {
		const tokens = 40_001
		expect(getFirstDiffChars(tokens, 100_000)).toBe(
			Math.floor(tokens * FIRST_MESSAGE_SHARE * CHARS_PER_TOKEN)
		)
	})
	test('clamps the first diff to its floor and caller maximum', () => {
		expect(getFirstDiffChars(0, 100_000)).toBe(MIN_FIRST_DIFF_CHARS)
		expect(getFirstDiffChars(1_000_000, 10_000)).toBe(10_000)
		expect(getFirstDiffChars(0, MIN_FIRST_DIFF_CHARS - 1)).toBe(
			MIN_FIRST_DIFF_CHARS - 1
		)
	})
	for (const [tokens, expected] of [
		[0, 1],
		[MIN_UNIT_TOKENS - 1, 1],
		[MIN_UNIT_TOKENS * 2 - 1, 1],
		[MIN_UNIT_TOKENS * 2, 2],
		[MIN_UNIT_TOKENS * MAX_REVIEW_UNITS * 2, MAX_REVIEW_UNITS],
	] as const)
		test(`splits ${tokens} tokens into ${expected} units`, () =>
			expect(getUnitCount(tokens, 0)).toBe(expected))
	test('shares validation leftovers, floors and clamps both ends', () => {
		expect(getValidationTokens(100_001, 3)).toBe(Math.floor(100_001 / 3))
		expect(getValidationTokens(-1, 2)).toBe(MIN_VALIDATION_TOKENS)
		expect(getValidationTokens(MIN_VALIDATION_TOKENS * 2, 2)).toBe(
			MIN_VALIDATION_TOKENS
		)
		expect(getValidationTokens(MAX_VALIDATION_TOKENS * 3, 2)).toBe(
			MAX_VALIDATION_TOKENS
		)
		expect(getValidationTokens(MAX_VALIDATION_TOKENS, 0)).toBe(
			MAX_VALIDATION_TOKENS
		)
	})
	test('keeps every unit without a filter and none for an empty filter', () => {
		expect(getUnitsToReview(UNITS, undefined)).toEqual(UNITS)
		expect(getUnitsToReview(UNITS, [])).toEqual([])
		expect(getUnitsToReview(UNITS, ['absent.ts'])).toEqual([])
	})
	test('keeps mixed units once when any path matches', () =>
		expect(getUnitsToReview(UNITS, ['billing.ts', 'billing.ts'])).toEqual(
			UNITS.slice(0, 2)
		))
	for (const [failed, unfinished, status] of [
		[true, 0, 'failed'],
		[true, 2, 'incomplete'],
		[false, 1, 'incomplete'],
		[false, 0, 'ok'],
	] as const)
		test(`${failed ? 'failed' : 'answered'} with ${unfinished} unfinished jobs is ${status}`, () =>
			expect(toFinderStatus(failed, unfinished)).toBe(status))
})
