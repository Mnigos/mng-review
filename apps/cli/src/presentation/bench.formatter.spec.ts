import {
	DEFAULT_LINE_WINDOW,
	toBenchTotals,
	type CaseScore,
} from '@mng-review/domain'
import type { BenchReport, CaseReport, TokensByModel } from '@mng-review/engine'
import { REPORTED_FINDING } from '../shared/mocks/review-cli.helper'
import { formatBenchJson, formatBenchText } from './bench.formatter'

const EXPECTED = {
	id: 'duplicate-charge',
	path: REPORTED_FINDING.path,
	line: REPORTED_FINDING.line,
	label: 'real',
	summary: 'A retry charges twice.',
} as const
const NOISE = {
	...EXPECTED,
	id: 'deliberate-retry',
	label: 'intentional',
} as const
const MISSED = {
	...EXPECTED,
	id: 'missing-guard',
	line: 81,
	summary: 'A guard is missing.',
} as const
const SCORE = {
	found: [{ expected: EXPECTED, finding: REPORTED_FINDING }],
	missed: [MISSED],
	noise: [{ expected: NOISE, finding: REPORTED_FINDING }],
	unmatched: [{ ...REPORTED_FINDING, title: 'Unmatched retry', line: 100 }],
} as const satisfies CaseScore
const TOKENS = {
	reviewer: {
		calls: 2,
		inputTokens: 6,
		outputTokens: 4,
		reasoningTokens: 1,
		totalTokens: 10,
	},
} as const satisfies TokensByModel
const CASE = {
	id: 'checkout-timeout',
	base: 'base',
	head: 'head',
	score: SCORE,
	nits: 3,
	tokens: TOKENS,
	wallMillis: 1200,
} as const satisfies CaseReport
const REPORT = {
	file: 'bench.yml',
	rulesSource: 'working tree',
	lineWindow: DEFAULT_LINE_WINDOW,
	cases: [CASE],
	totals: toBenchTotals([CASE]),
	tokens: TOKENS,
	wallMillis: 1500,
} as const satisfies BenchReport

describe('formatBenchText', () => {
	test('text and JSON retain scores and identify unfinished work for an incomplete case', () => {
		const entry: CaseReport = {
			...CASE,
			incomplete: [
				'reviewer: src/viewer.ts: close()',
				'validation of 1 finding(s)',
			],
		}
		const report = { ...REPORT, cases: [entry] }
		const text = formatBenchText(report)
		expect(text).toContain(
			'    incomplete  token budget spent: reviewer: src/viewer.ts: close(); validation of 1 finding(s)'
		)
		expect(text).toContain('real 1/2 found, 1 missed')
		expect(text).toContain(
			`    found  duplicate-charge (real)  ${REPORTED_FINDING.path}:2 medium ${REPORTED_FINDING.title}`
		)
		expect(JSON.parse(formatBenchJson(report))).toEqual(report)
		expect(formatBenchText(REPORT)).not.toContain('incomplete')
	})
	test('lists each case and every finding category, totals, percentage recall and tokens', () => {
		const second = { ...CASE, id: 'checkout-retry' }
		const text = formatBenchText({
			...REPORT,
			cases: [CASE, second],
			totals: toBenchTotals([CASE, second]),
			tokens: {
				reviewer: {
					calls: 4,
					inputTokens: 12,
					outputTokens: 8,
					reasoningTokens: 2,
					totalTokens: 20,
				},
			},
		})
		for (const line of [
			`Benchmark bench.yml, rules: working tree, line window ${DEFAULT_LINE_WINDOW}`,
			'checkout-timeout  real 1/2 found, 1 missed, noise 1, unmatched 1, nits 3, 1.2 s',
			'checkout-retry  real 1/2 found, 1 missed, noise 1, unmatched 1, nits 3, 1.2 s',
			`    found  duplicate-charge (real)  ${REPORTED_FINDING.path}:2 medium ${REPORTED_FINDING.title}`,
			`    missed  missing-guard  ${REPORTED_FINDING.path}:81  A guard is missing.`,
			`    noise  deliberate-retry (intentional)  ${REPORTED_FINDING.path}:2 medium ${REPORTED_FINDING.title}`,
			`    unmatched  ${REPORTED_FINDING.path}:100 medium Unmatched retry`,
			'    tokens  reviewer  10 (6 in, 4 out, 2 call(s))',
			'Totals (2 case(s)): real found 2, missed 2, noise 2, unmatched 2, nits 6',
			'Recall: 50.0% (2 of 4 real)',
			'Unmatched per case: 1.00',
			'Tokens:\n  reviewer  20 (12 in, 8 out, 4 call(s))',
			'Wall time: 1.5 s',
		])
			expect(text).toContain(line)
		expect(text.indexOf('checkout-timeout')).toBeLessThan(
			text.indexOf('checkout-retry')
		)
	})
	test('uses n/a recall when there are no real entries and shows skipped and endpoint errors', () => {
		const entry = {
			...CASE,
			score: { found: [], missed: [], noise: [], unmatched: [] },
			tokens: {},
			skipped: 'label skip-review is in skip.labels',
			endpointError: 'fixture endpoint failure',
		}
		const text = formatBenchText({
			...REPORT,
			cases: [entry],
			totals: toBenchTotals([entry]),
			tokens: {},
		})
		expect(text).toContain('Recall: n/a (no real entries)')
		expect(text).toContain('    skipped  label skip-review is in skip.labels')
		expect(text).toContain('    endpoint error  fixture endpoint failure')
		expect(text).not.toContain('Tokens:')
	})
	test('empty run prints zero totals and n/a unmatched per case', () => {
		const text = formatBenchText({
			...REPORT,
			cases: [],
			totals: toBenchTotals([]),
			tokens: {},
		})
		expect(text).toContain(
			'Totals (0 case(s)): real found 0, missed 0, noise 0, unmatched 0, nits 0'
		)
		expect(text).toContain('Unmatched per case: n/a')
		expect(text).toContain('Recall: n/a (no real entries)')
	})
})

describe('formatBenchJson', () => {
	test('preserves the full report including reasoning usage and per-case details', () => {
		expect(JSON.parse(formatBenchJson(REPORT))).toEqual(REPORT)
	})
})
