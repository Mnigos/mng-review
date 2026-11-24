import type { RiskRating } from '@mng-review/engine'
import { reviewReport } from '../shared/mocks/review-report.helper'
import { formatReviewText } from './review.formatter'
import { toRiskLines } from './risk.formatter'

const BINDING = {
	head: 'a'.repeat(40),
	base: 'b'.repeat(40),
	rules: 'abc123def456',
	floor: true,
	floors: [
		{
			name: 'runtime',
			level: 'high',
			builtIn: false,
			paths: ['src/store.ts'],
			added: 2,
			deleted: 1,
		},
	],
} as const
const RATED = {
	...BINDING,
	status: 'rated',
	level: 'high',
	model: 'low',
	reasons: ['Stored data changes.'],
	refs: ['src/store.ts:2-3'],
	up: 'More callers.',
	down: 'No stored data.',
	rater: 'model-a',
} as const satisfies RiskRating
const UNRATED = {
	...BINDING,
	status: 'unrated',
	reason: 'coverage-gap',
	detail: 'src/store.ts was unread.',
} as const satisfies RiskRating

describe('risk text', () => {
	test('prints a rated result, its model level, reasons, refs, directions, floors and binding', () => {
		const text = toRiskLines(RATED).join('\n')
		for (const line of [
			'Risk: high (the rater said low; raised by floors or findings), rated by model-a',
			'  - Stored data changes.',
			'  refs: src/store.ts:2-3',
			'  higher if: More callers.',
			'  lower if: No stored data.',
			'  floor runtime: high (1 file(s), +2 -1)',
			'  head aaaaaaa, base bbbbbbb, rules abc123def456',
		])
			expect(text).toContain(line)
		expect(formatReviewText({ ...reviewReport(), rating: RATED })).toContain(
			text
		)
	})
	test('prints why a result is unrated together with floors and binding', () => {
		const text = toRiskLines(UNRATED).join('\n')
		expect(text).toContain(
			'Risk: not rated (coverage-gap): src/store.ts was unread.'
		)
		expect(text).toContain('floor runtime: high (1 file(s), +2 -1)')
		expect(text).toContain('head aaaaaaa, base bbbbbbb, rules abc123def456')
		expect(formatReviewText({ ...reviewReport(), rating: UNRATED })).toContain(
			text
		)
	})
	test('does not claim a raise or print absent optional fields', () => {
		const text = toRiskLines({
			...BINDING,
			floors: [],
			floor: false,
			status: 'rated',
			level: 'low',
			model: 'low',
			reasons: ['Local edit.'],
			refs: [],
			rater: 'model-a',
		}).join('\n')
		expect(text).toContain('Risk: low, rated by model-a')
		for (const omitted of [
			'raised by',
			'refs:',
			'higher if:',
			'lower if:',
			'floor runtime',
		])
			expect(text).not.toContain(omitted)
	})
})
