import {
	isOutOfTokens,
	toAffordableOutputs,
	toEstimatedTokens,
} from './loop-budget.helper'
import { CHARS_PER_TOKEN } from './review.constants'

const BUDGET = { runTokens: 1000, conversationTokens: 100 } as const

describe('loop budgets', () => {
	for (const [spentTokens, nextInputTokens, expected] of [
		[19, 40, false],
		[20, 40, true],
		[21, 40, true],
		[0, 50, true],
		[0, 51, true],
		[0, 49, false],
	] as const)
		test(`${spentTokens} spent plus twice ${nextInputTokens} input ${expected ? 'reaches' : 'fits'} the share`, () =>
			expect(isOutOfTokens(BUDGET, { spentTokens, nextInputTokens })).toBe(
				expected
			))
	test('an absent conversation budget does not force wrap-up', () =>
		expect(
			isOutOfTokens(undefined, { spentTokens: 1000, nextInputTokens: 1000 })
		).toBe(false))
	for (const chars of [0, 1, CHARS_PER_TOKEN, CHARS_PER_TOKEN + 1])
		test(`estimates ${chars} characters with upward rounding`, () =>
			expect(toEstimatedTokens('x'.repeat(chars))).toBe(
				Math.ceil(chars / CHARS_PER_TOKEN)
			))
})

describe('affordable tool outputs', () => {
	const refusal = 'budget reached'
	const state = { spentTokens: 40, nextInputTokens: 50 }
	const output = 'x'.repeat(CHARS_PER_TOKEN * 6)

	test('without a budget preserves every output in order without mutating the input', () => {
		const outputs = Object.freeze([output, output, 'last'])
		expect(toAffordableOutputs(outputs, undefined, state, refusal)).toEqual(
			outputs
		)
		expect(outputs).toEqual([output, output, 'last'])
	})
	test('keeps outputs that exactly fill the space left after spent and next input', () =>
		expect(
			toAffordableOutputs(
				[output, 'y'.repeat(CHARS_PER_TOKEN * 4)],
				BUDGET,
				state,
				refusal
			)
		).toEqual([output, 'y'.repeat(CHARS_PER_TOKEN * 4)]))
	test('refuses outputs beyond the remaining room in their original positions', () =>
		expect(
			toAffordableOutputs([output, output, output], BUDGET, state, refusal)
		).toEqual([output, refusal, refusal]))
	test('rounds each output up before deciding if it fits', () =>
		expect(
			toAffordableOutputs(
				['x', 'y'],
				BUDGET,
				{ spentTokens: 49, nextInputTokens: 50 },
				refusal
			)
		).toEqual(['x', refusal]))
	for (const spentTokens of [50, 51])
		test(`refuses nonempty outputs when remaining room is ${50 - spentTokens}`, () =>
			expect(
				toAffordableOutputs(
					['x', output],
					BUDGET,
					{ spentTokens, nextInputTokens: 50 },
					refusal
				)
			).toEqual([refusal, refusal]))
	test('an empty batch stays empty even when the budget is exhausted', () =>
		expect(
			toAffordableOutputs(
				[],
				BUDGET,
				{ spentTokens: 100, nextInputTokens: 100 },
				refusal
			)
		).toEqual([]))
})
