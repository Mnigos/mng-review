import { isOutOfTokens, toEstimatedTokens } from './loop-budget.helper'
import { CHARS_PER_TOKEN } from './review.constants'

const BUDGET = { runTokens: 1000, conversationTokens: 100 } as const

describe('loop budgets', () => {
	for (const [spentTokens, lastInputTokens, expected] of [
		[19, 40, false],
		[20, 40, true],
		[21, 40, true],
		[0, 50, true],
		[0, 51, true],
		[0, 49, false],
	] as const)
		test(`${spentTokens} spent plus twice ${lastInputTokens} input ${expected ? 'reaches' : 'fits'} the share`, () =>
			expect(isOutOfTokens(BUDGET, { spentTokens, lastInputTokens })).toBe(
				expected
			))
	test('an absent conversation budget does not force wrap-up', () =>
		expect(
			isOutOfTokens(undefined, { spentTokens: 1000, lastInputTokens: 1000 })
		).toBe(false))
	for (const chars of [0, 1, CHARS_PER_TOKEN, CHARS_PER_TOKEN + 1])
		test(`estimates ${chars} characters with upward rounding`, () =>
			expect(toEstimatedTokens('x'.repeat(chars))).toBe(
				Math.ceil(chars / CHARS_PER_TOKEN)
			))
})
