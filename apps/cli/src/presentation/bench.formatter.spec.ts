import {
	DEFAULT_LINE_WINDOW,
	type BenchFinding,
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
const FINDING = {
	...REPORTED_FINDING,
	status: 'confirmed',
} as const satisfies BenchFinding
const SCORE = {
	found: [{ expected: EXPECTED, finding: FINDING }],
	missed: [MISSED],
	near: [],
	noise: [{ expected: NOISE, finding: FINDING }],
	unmatched: [{ ...FINDING, title: 'Unmatched retry', line: 100 }],
} as const satisfies CaseScore
const TOKENS = {
	reviewer: {
		calls: 2,
		inputTokens: 6,
		cachedInputTokens: 0,
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
	depth: { level: 'balanced', source: 'review.yml depth' },
	risk: 'normal',
	rejected: [],
	nits: 3,
	tokens: TOKENS,
	tokenSources: {},
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
		expect(text).toContain('real 1/2 found, 0 near, 1 missed')
		expect(text).toContain(
			`    found  duplicate-charge (real)  ${REPORTED_FINDING.path}:2 medium confirmed ${REPORTED_FINDING.title}`
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
					cachedInputTokens: 0,
					outputTokens: 8,
					reasoningTokens: 2,
					totalTokens: 20,
				},
			},
		})
		for (const line of [
			`Benchmark bench.yml, rules: working tree, line window ${DEFAULT_LINE_WINDOW}`,
			'checkout-timeout  balanced  real 1/2 found, 0 near, 1 missed, noise 1, unmatched 1, rejected 0, nits 3, 1.2 s',
			'checkout-retry  balanced  real 1/2 found, 0 near, 1 missed, noise 1, unmatched 1, rejected 0, nits 3, 1.2 s',
			`    found  duplicate-charge (real)  ${REPORTED_FINDING.path}:2 medium confirmed ${REPORTED_FINDING.title}`,
			`    missed  missing-guard  ${REPORTED_FINDING.path}:81  A guard is missing.`,
			`    noise  deliberate-retry (intentional)  ${REPORTED_FINDING.path}:2 medium confirmed ${REPORTED_FINDING.title}`,
			`    unmatched  ${REPORTED_FINDING.path}:100 medium confirmed Unmatched retry`,
			'    tokens  reviewer  10 (6 in, 0 cached, 4 out, 2 call(s))',
			'Totals (2 case(s)): real found 2 (2 confirmed, 0 unverified), near 0, missed 2, noise 2, unmatched 2, nits 6',
			'Recall: 50.0% (2 of 4 real)',
			'Unmatched per case: 1.00',
			'Tokens:\n  reviewer  20 (12 in, 0 cached, 8 out, 4 call(s))',
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
			score: { found: [], missed: [], near: [], noise: [], unmatched: [] },
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
			'Totals (0 case(s)): real found 0 (0 confirmed, 0 unverified), near 0, missed 0, noise 0, unmatched 0, nits 0'
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

test('bench case text and JSON carry source token accounting', () => {
	const tokenSources = {
		validator: {
			...TOKENS.reviewer,
			conversations: 2,
			firstMessageTokens: 4,
			historyTokens: 2,
		},
	}
	const report = { ...REPORT, cases: [{ ...CASE, tokenSources }] }
	expect(formatBenchText(report)).toContain(
		'    source  validator  10 (4 first messages, 2 history, 0 cached, 4 out, 2 call(s), 2 conversation(s))'
	)
	expect(JSON.parse(formatBenchJson(report))).toMatchObject({
		cases: [{ tokenSources }],
	})
})

test('bench text and JSON retain near, rejected, depth, risk and every validation status', () => {
	const near = {
		expected: { ...EXPECTED, id: 'near' },
		finding: { ...FINDING, path: 'src/billing/retry.ts', status: 'unverified' },
	} as const
	const rejected = {
		path: FINDING.path,
		line: 7,
		title: 'Guard bypass',
		severity: 'high',
		reason: 'Caller checks ownership.',
		validatedBy: 'validator',
	} as const
	const entry = {
		...CASE,
		depth: { level: 'deep', source: 'risk_paths' },
		risk: 'risky',
		rejected: [rejected],
		score: {
			...SCORE,
			near: [near],
			unmatched: [{ ...FINDING, status: 'unvalidated' }],
		},
	} as const satisfies CaseReport
	const report = { ...REPORT, cases: [entry], totals: toBenchTotals([entry]) }
	const text = formatBenchText(report)
	for (const line of [
		'checkout-timeout  deep  real 1/3 found, 1 near, 1 missed, noise 1, unmatched 1, rejected 1',
		`    near  near (real)  src/billing/retry.ts:${FINDING.line} medium unverified ${FINDING.title}`,
		`    unmatched  ${FINDING.path}:${FINDING.line} medium unvalidated ${FINDING.title}`,
		`    rejected  ${rejected.path}:7 high Guard bypass (validator: Caller checks ownership.)`,
		'    depth  deep (risk_paths), risk risky',
		'Totals (1 case(s)): real found 1 (1 confirmed, 0 unverified), near 1, missed 1',
		'Recall: 33.3% (1 of 3 real)',
	])
		expect(text).toContain(line)
	expect(JSON.parse(formatBenchJson(report))).toEqual(report)
})

test('bench totals text reports the confirmed and unverified found counts separately', () => {
	const entry = {
		...CASE,
		score: {
			...SCORE,
			found: [
				{ expected: EXPECTED, finding: { ...FINDING, status: 'unverified' } },
			],
		},
	} as const satisfies CaseReport
	const report = {
		...REPORT,
		cases: [CASE, entry],
		totals: toBenchTotals([CASE, entry]),
	}
	expect(formatBenchText(report)).toContain(
		'real found 2 (1 confirmed, 1 unverified)'
	)
})
