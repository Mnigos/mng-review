import type { TokensByModel } from '../../../platform/llm/token-ledger.service'
import { toTokenTotals } from './bench-report.helper'

const FIRST = {
	reviewer: {
		calls: 2,
		inputTokens: 10,
		outputTokens: 5,
		reasoningTokens: 2,
		totalTokens: 15,
	},
	router: {
		calls: 1,
		inputTokens: 3,
		outputTokens: 2,
		reasoningTokens: 1,
		totalTokens: 5,
	},
} as const satisfies TokensByModel
const SECOND = {
	reviewer: {
		calls: 3,
		inputTokens: 20,
		outputTokens: 8,
		reasoningTokens: 4,
		totalTokens: 28,
	},
	validator: {
		calls: 1,
		inputTokens: 7,
		outputTokens: 3,
		reasoningTokens: 0,
		totalTokens: 10,
	},
} as const satisfies TokensByModel

describe('toTokenTotals', () => {
	test('sums every usage field per model and retains models seen in only one run', () => {
		expect(toTokenTotals([FIRST, {}, SECOND])).toEqual({
			reviewer: {
				calls: 5,
				inputTokens: 30,
				outputTokens: 13,
				reasoningTokens: 6,
				totalTokens: 43,
			},
			router: FIRST.router,
			validator: SECOND.validator,
		})
		expect(FIRST.reviewer.totalTokens).toBe(15)
		expect(SECOND.reviewer.totalTokens).toBe(28)
	})
	test('no runs and empty runs have no model totals', () => {
		expect(toTokenTotals([])).toEqual({})
		expect(toTokenTotals([{}, {}])).toEqual({})
	})
})
