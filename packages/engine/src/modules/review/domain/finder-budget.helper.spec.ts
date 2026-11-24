import { MAX_REVIEW_UNITS, type ReviewUnit } from '@mng-review/domain'
import {
	getCoverageScale,
	getFirstDiffChars,
	getReadingTokens,
	getUnitCount,
	getValidationTokens,
	getUnitsToReview,
	toFinderStatus,
	toUnreadReport,
} from './finder-budget.helper'
import { getMissingTokens, toAffordableOutputs } from './loop-budget.helper'
import {
	CHARS_PER_TOKEN,
	FIRST_MESSAGE_SHARE,
	MAX_UNIT_DIFF_CHARS,
	MIN_FIRST_DIFF_CHARS,
	MIN_UNIT_TOKENS,
	MIN_VALIDATION_TOKENS,
	MAX_VALIDATION_TOKENS,
	TURN_OUTPUT_TOKENS,
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

/** Whether a conversation of `conversationTokens` reads `read` tokens in each of `turns` turns, then answers. */
function readsEverything(
	conversationTokens: number,
	first: number,
	read: number,
	turns: number
): boolean {
	const budget = { runTokens: Number.MAX_SAFE_INTEGER, conversationTokens }
	const output = 'x'.repeat(read * CHARS_PER_TOKEN)
	const end = Array.from({ length: turns }).reduce<
		{ spentTokens: number; nextInputTokens: number } | undefined
	>(
		state => {
			if (!state || getMissingTokens(budget, state) > 0) return undefined
			const sent = {
				spentTokens:
					state.spentTokens + state.nextInputTokens + TURN_OUTPUT_TOKENS,
				nextInputTokens: state.nextInputTokens + TURN_OUTPUT_TOKENS,
			}
			const [kept] = toAffordableOutputs([output], budget, sent, 'refused')
			if (kept !== output) return undefined
			return { ...sent, nextInputTokens: sent.nextInputTokens + read }
		},
		{ spentTokens: 0, nextInputTokens: first }
	)
	return (
		end !== undefined &&
		end.spentTokens + end.nextInputTokens + TURN_OUTPUT_TOKENS <=
			conversationTokens
	)
}

describe('coverage sizing', () => {
	for (const [first, read, turns] of [
		[12_000, 30_000, 3],
		[4000, 90_000, 5],
		[20_000, 0, 3],
	] as const)
		test(`sizes ${read} read tokens over ${turns} turns after a ${first}-token first message to the loop's rules`, () => {
			const need = getReadingTokens(first, read, turns)
			const perTurn = Math.ceil(read / turns)
			expect(readsEverything(need, first, perTurn, turns)).toBeTruthy()
			expect(readsEverything(need - 1, first, perTurn, turns)).toBe(false)
		})
	test('more turns cost more, since every call re-sends the conversation', () => {
		expect(getReadingTokens(10_000, 30_000, 4)).toBeGreaterThan(
			getReadingTokens(10_000, 30_000, 3)
		)
	})
	test('grants every need that fits and cuts all alike past the room', () => {
		expect(getCoverageScale(100, 100)).toBe(1)
		expect(getCoverageScale(0, 0)).toBe(1)
		expect(getCoverageScale(200, 50)).toBe(0.25)
		expect(getCoverageScale(200, -10)).toBe(0)
	})
	test('splits a large diff into more units than its tokens pay for', () => {
		expect(getUnitCount(MIN_UNIT_TOKENS, MAX_UNIT_DIFF_CHARS * 3 + 1)).toBe(4)
		expect(getUnitCount(MIN_UNIT_TOKENS * 5, MAX_UNIT_DIFF_CHARS)).toBe(5)
		expect(getUnitCount(MIN_UNIT_TOKENS, MAX_UNIT_DIFF_CHARS * 100)).toBe(
			MAX_REVIEW_UNITS
		)
	})
	test('reports unread files with their count, and nothing when none', () => {
		const files = [
			{ path: 'a.ts', reason: 'untouched' },
			{ path: 'b.ts', reason: 'deletions' },
		] as const
		expect(toUnreadReport(files)).toEqual({ unread: 2, unreadFiles: files })
		expect(toUnreadReport([])).toEqual({})
	})
})
