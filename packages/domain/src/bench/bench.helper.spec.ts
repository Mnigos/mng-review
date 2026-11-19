import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { ConfigError } from '../config/config.errors'
import { SAME_DESCRIPTION_OVERLAP } from '../findings/finding.constants'
import { getWordCoverage } from '../findings/finding.helper'
import {
	benchFinding as finding,
	expectedFinding as expected,
} from '../shared/mocks/bench-test.helper'
import { finding as domainFinding } from '../shared/mocks/domain-test.helper'
import type { KeptFinding } from '../validation/validation.types'
import type { BenchFile } from './bench-file.schema'
import { BENCH_FILE_VERSION, DEFAULT_LINE_WINDOW } from './bench.constants'
import {
	getBenchCases,
	toBenchFinding,
	toBenchTotals,
	toCaseScore,
} from './bench.helper'

const FILE = {
	version: BENCH_FILE_VERSION,
	cases: ['first', 'second', 'third'].map(id => ({
		id,
		base: 'base',
		head: 'head',
		labels: [],
		expected: [],
	})),
} as const satisfies BenchFile

layer(Layer.empty)('getBenchCases', test => {
	test.effect('empty selection returns all cases in file order', () =>
		Effect.gen(function* () {
			expect(yield* getBenchCases(FILE, [], 'bench.yml')).toEqual(FILE.cases)
		})
	)
	test.effect(
		'selection keeps file order even for repeated and reversed ids',
		() =>
			Effect.gen(function* () {
				expect(
					(yield* getBenchCases(
						FILE,
						['third', 'first', 'third'],
						'bench.yml'
					)).map(entry => entry.id)
				).toEqual(['first', 'third'])
			})
	)
	test.effect('unknown id fails naming the file and id', () =>
		Effect.gen(function* () {
			const error = yield* getBenchCases(
				FILE,
				['first', 'missing-case'],
				'bench.yml'
			).pipe(Effect.flip)
			expect(error).toBeInstanceOf(ConfigError)
			expect(error.message).toContain('bench.yml')
			expect(error.reason).toContain('missing-case')
		})
	)
})

describe('toCaseScore', () => {
	for (const offset of [0, 1, -1, DEFAULT_LINE_WINDOW, -DEFAULT_LINE_WINDOW])
		test(`matches equal paths at offset ${offset}`, () => {
			const entry = expected()
			const bug = finding({ line: entry.line + offset })
			expect(
				toCaseScore({
					expected: [entry],
					findings: [bug],
					lineWindow: DEFAULT_LINE_WINDOW,
				})
			).toEqual({
				found: [{ expected: entry, finding: bug }],
				missed: [],
				near: [],
				noise: [],
				unmatched: [],
			})
		})
	for (const offset of [DEFAULT_LINE_WINDOW + 1, -DEFAULT_LINE_WINDOW - 1])
		test(`does not match one past the window at offset ${offset}`, () => {
			const entry = expected()
			const bug = finding({ line: entry.line + offset })
			expect(
				toCaseScore({
					expected: [entry],
					findings: [bug],
					lineWindow: DEFAULT_LINE_WINDOW,
				})
			).toEqual({
				found: [],
				missed: [entry],
				near: [],
				noise: [],
				unmatched: [bug],
			})
		})
	test('different directories never match even at the same line', () => {
		const entry = expected()
		const bug = finding({ path: 'src/refunds/refund.ts', line: entry.line })
		expect(
			toCaseScore({
				expected: [entry],
				findings: [bug],
				lineWindow: DEFAULT_LINE_WINDOW,
			})
		).toEqual({
			found: [],
			missed: [entry],
			near: [],
			noise: [],
			unmatched: [bug],
		})
	})
	test('one entry consumes only the closest finding', () => {
		const entry = expected({ line: 10 })
		const far = finding({ line: 12 })
		const near = finding({ line: 11 })
		expect(
			toCaseScore({
				expected: [entry],
				findings: [far, near],
				lineWindow: DEFAULT_LINE_WINDOW,
			})
		).toEqual({
			found: [{ expected: entry, finding: near }],
			missed: [],
			near: [],
			noise: [],
			unmatched: [far],
		})
	})
	test('one finding consumes only the closest entry, regardless of entry order', () => {
		const far = expected({ id: 'far', line: 10 })
		const near = expected({ id: 'near', line: 13 })
		const bug = finding({ line: 12 })
		expect(
			toCaseScore({
				expected: [far, near],
				findings: [bug],
				lineWindow: DEFAULT_LINE_WINDOW,
			})
		).toEqual({
			found: [{ expected: near, finding: bug }],
			missed: [far],
			near: [],
			noise: [],
			unmatched: [],
		})
	})
	test('closest pairs win globally before earlier entries', () => {
		const first = expected({ id: 'first', line: 10 })
		const second = expected({ id: 'second', line: 12 })
		const nearSecond = finding({ line: 12 })
		const nearFirst = finding({ line: 11 })
		expect(
			toCaseScore({
				expected: [first, second],
				findings: [nearSecond, nearFirst],
				lineWindow: 2,
			}).found
		).toEqual([
			{ expected: first, finding: nearFirst },
			{ expected: second, finding: nearSecond },
		])
	})
	test('entry ties go to the earlier entry', () => {
		const first = expected({ id: 'first', line: 10 })
		const second = expected({ id: 'second', line: 12 })
		const bug = finding({ line: 11 })
		expect(
			toCaseScore({ expected: [first, second], findings: [bug], lineWindow: 1 })
		).toEqual({
			found: [{ expected: first, finding: bug }],
			missed: [second],
			near: [],
			noise: [],
			unmatched: [],
		})
	})
	test('finding ties go to the earlier finding after entry order', () => {
		const first = expected({ id: 'first', line: 10 })
		const second = expected({ id: 'second', line: 10 })
		const earlier = finding({ line: 9, title: 'Earlier finding' })
		const later = finding({ line: 11, title: 'Later finding' })
		expect(
			toCaseScore({
				expected: [first, second],
				findings: [earlier, later],
				lineWindow: 1,
			}).found
		).toEqual([
			{ expected: first, finding: earlier },
			{ expected: second, finding: later },
		])
	})
	test('classifies real found and missed, intentional and false noise, and unmatched findings', () => {
		const entries = [
			expected({ line: 10 }),
			expected({ id: 'missing', line: 20 }),
			expected({ id: 'deliberate', line: 30, label: 'intentional' }),
			expected({ id: 'false-alarm', line: 40, label: 'false' }),
			expected({ id: 'quiet', line: 50, label: 'false' }),
		]
		const bugs = [10, 30, 40, 60].map(line => finding({ line }))
		const score = toCaseScore({
			expected: entries,
			findings: bugs,
			lineWindow: 0,
		})
		expect(score.found.map(match => match.expected.id)).toEqual([
			'duplicate-charge',
		])
		expect(score.missed.map(entry => entry.id)).toEqual(['missing'])
		expect(score.noise.map(match => match.expected.id)).toEqual([
			'deliberate',
			'false-alarm',
		])
		expect(score.unmatched).toEqual([bugs[3]])
	})
	test('window zero accepts only the exact line', () => {
		const entry = expected()
		const exact = finding({ line: entry.line })
		const adjacent = finding({ line: entry.line + 1 })
		expect(
			toCaseScore({
				expected: [entry],
				findings: [adjacent, exact],
				lineWindow: 0,
			})
		).toEqual({
			found: [{ expected: entry, finding: exact }],
			missed: [],
			near: [],
			noise: [],
			unmatched: [adjacent],
		})
	})
	test('empty inputs give an empty score', () => {
		expect(toCaseScore({ expected: [], findings: [], lineWindow: 0 })).toEqual({
			found: [],
			missed: [],
			near: [],
			noise: [],
			unmatched: [],
		})
	})
})

describe('toBenchTotals', () => {
	test('sums counts and nits, weights recall by real entries, and averages unmatched by cases', () => {
		const first = toCaseScore({
			expected: [
				expected({ line: 10 }),
				expected({ id: 'missed', line: 30 }),
				expected({ id: 'noise', line: 50, label: 'intentional' }),
			],
			findings: [10, 50, 70].map(line => finding({ line })),
			lineWindow: 0,
		})
		const second = toCaseScore({
			expected: [expected({ line: 10 })],
			findings: [10, 70, 80].map(line => finding({ line })),
			lineWindow: 0,
		})
		expect(
			toBenchTotals([
				{ score: first, nits: 2 },
				{ score: second, nits: 3 },
			])
		).toEqual({
			cases: 2,
			found: 2,
			confirmed: 0,
			unverified: 0,
			near: 0,
			missed: 1,
			noise: 1,
			unmatched: 3,
			nits: 5,
			recall: 2 / 3,
			unmatchedPerCase: 1.5,
		})
	})
	test('no real entries gives null recall even with noise and unmatched findings', () => {
		const score = toCaseScore({
			expected: [expected({ label: 'false', line: 10 })],
			findings: [10, 20].map(line => finding({ line })),
			lineWindow: 0,
		})
		expect(toBenchTotals([{ score, nits: 1 }])).toEqual({
			cases: 1,
			found: 0,
			confirmed: 0,
			unverified: 0,
			near: 0,
			missed: 0,
			noise: 1,
			unmatched: 1,
			nits: 1,
			recall: null,
			unmatchedPerCase: 1,
		})
	})
	test('no cases gives zero sums and null ratios', () => {
		expect(toBenchTotals([])).toEqual({
			cases: 0,
			found: 0,
			confirmed: 0,
			unverified: 0,
			near: 0,
			missed: 0,
			noise: 0,
			unmatched: 0,
			nits: 0,
			recall: null,
			unmatchedPerCase: null,
		})
	})
})

describe('toBenchFinding', () => {
	test.each([
		'confirmed',
		'unverified',
		'unvalidated',
		'missing',
		'rejected',
	] as const)(
		'maps %s validation and retains every kept finding field',
		status => {
			const validation =
				status === 'missing'
					? {}
					: {
							validation:
								status === 'unvalidated'
									? ({ status, error: 'No usable answer' } as const)
									: ({
											status,
											severity: 'high',
											reason: 'Repository evidence',
											evidence: ['src/billing/charge.ts:2'],
											model: 'validator',
											premise: 'Dependency behaviour',
										} as const),
						}
			const bug = {
				...domainFinding({
					evidence: ['src/billing/charge.ts:2 retry'],
					suggestion: 'Deduplicate invoice retries.',
					agents: ['reviewer', 'billing'],
					models: ['model-a', 'model-b'],
				}),
				reportedSeverity: 'medium',
				severity: 'high',
				placement: 'summary',
				...validation,
			} as const satisfies KeptFinding
			expect(toBenchFinding(bug)).toEqual({
				...bug,
				status:
					status === 'missing' || status === 'rejected'
						? 'unvalidated'
						: status,
			})
		}
	)
})

describe('near matches', () => {
	test('rejects a short finding that covers only three of eight summary words', () => {
		const entry = expected({
			summary: 'invoice retry duplicate balance ledger timeout cache session',
		})
		const bug = finding({
			path: 'src/billing/refund.ts',
			title: 'invoice',
			trigger: 'retry',
			impact: 'duplicate',
		})
		expect(
			getWordCoverage(
				entry.summary,
				[bug.title, bug.trigger, bug.impact].join(' ')
			)
		).toBe(3 / 8)
		expect(
			toCaseScore({ expected: [entry], findings: [bug], lineWindow: 0 })
		).toEqual({
			found: [],
			missed: [entry],
			near: [],
			noise: [],
			unmatched: [bug],
		})
	})
	test('accepts exactly the description-overlap threshold using title, trigger and impact together', () => {
		const entry = expected({ summary: 'invoice retry duplicate balance' })
		const bug = finding({
			path: 'src/billing/refund.ts',
			line: 10_000,
			title: 'invoice',
			trigger: 'retry',
			impact: 'ledger timeout',
		})
		expect(
			getWordCoverage(
				entry.summary,
				[bug.title, bug.trigger, bug.impact].join(' ')
			)
		).toBe(SAME_DESCRIPTION_OVERLAP)
		expect(
			toCaseScore({ expected: [entry], findings: [bug], lineWindow: 0 })
		).toEqual({
			found: [],
			missed: [],
			near: [{ expected: entry, finding: bug }],
			noise: [],
			unmatched: [],
		})
	})
	test.each([
		{ title: 'invoice', trigger: 'ledger', impact: 'timeout network' },
		{
			title: 'Cache entry expires',
			trigger: 'Concurrent eviction',
			impact: 'Stale session',
		},
		{ title: 'the', trigger: 'and', impact: 'or' },
	])(
		'rejects sibling findings with too little shared description: %j',
		description => {
			const entry = expected({ summary: 'invoice retry duplicate balance' })
			const bug = finding({ path: 'src/billing/refund.ts', ...description })
			expect(
				getWordCoverage(
					entry.summary,
					[bug.title, bug.trigger, bug.impact].join(' ')
				)
			).toBeLessThan(SAME_DESCRIPTION_OVERLAP)
			expect(
				toCaseScore({
					expected: [entry],
					findings: [bug],
					lineWindow: DEFAULT_LINE_WINDOW,
				})
			).toEqual({
				found: [],
				missed: [entry],
				near: [],
				noise: [],
				unmatched: [bug],
			})
		}
	)
	test.each([
		['charge.ts', 'refund.ts', true],
		['charge.ts', 'src/refund.ts', false],
		['src/billing/charge.ts', 'src/billing/nested/refund.ts', false],
		['src/billing/charge.ts', 'src/billing-other/refund.ts', false],
		['src/billing/charge.ts', 'src/refund.ts', false],
		['src/billing/charge.ts', 'src/billing/charge.ts', false],
	] as const)(
		'directory rule for %s and %s gives near=%s',
		(path, otherPath, near) => {
			const entry = expected({
				path,
				summary: 'invoice retry duplicate balance',
			})
			const bug = finding({
				path: otherPath,
				line: entry.line + DEFAULT_LINE_WINDOW + 1,
				title: entry.summary,
				trigger: '',
				impact: '',
			})
			expect(
				toCaseScore({
					expected: [entry],
					findings: [bug],
					lineWindow: DEFAULT_LINE_WINDOW,
				})
			).toEqual({
				found: [],
				missed: near ? [] : [entry],
				near: near ? [{ expected: entry, finding: bug }] : [],
				noise: [],
				unmatched: near ? [] : [bug],
			})
		}
	)
	test('uses the first unmatched sibling and never consumes one finding for two entries', () => {
		const first = expected({
			id: 'first',
			summary: 'invoice retry duplicate balance',
		})
		const second = expected({
			id: 'second',
			path: 'src/billing/retry.ts',
			summary: first.summary,
		})
		const bug = finding({ path: 'src/billing/refund.ts', title: first.summary })
		expect(
			toCaseScore({ expected: [first, second], findings: [bug], lineWindow: 0 })
		).toEqual({
			found: [],
			missed: [second],
			near: [{ expected: first, finding: bug }],
			noise: [],
			unmatched: [],
		})
		const later = finding({ ...bug, path: 'src/billing/ledger.ts' })
		expect(
			toCaseScore({ expected: [first], findings: [bug, later], lineWindow: 0 })
		).toEqual({
			found: [],
			missed: [],
			near: [{ expected: first, finding: bug }],
			noise: [],
			unmatched: [later],
		})
	})
	test.each(['real', 'intentional', 'false'] as const)(
		'direct %s matches take precedence over a near match',
		label => {
			const near = expected({ summary: 'invoice retry duplicate balance' })
			const direct = expected({
				id: 'direct',
				path: 'src/billing/refund.ts',
				label,
				summary: near.summary,
			})
			const bug = finding({
				path: direct.path,
				line: direct.line,
				title: near.summary,
			})
			const match = { expected: direct, finding: bug }
			expect(
				toCaseScore({
					expected: [near, direct],
					findings: [bug],
					lineWindow: 0,
				})
			).toEqual({
				found: label === 'real' ? [match] : [],
				missed: [near],
				near: [],
				noise: label === 'real' ? [] : [match],
				unmatched: [],
			})
		}
	)
	test.each(['intentional', 'false'] as const)(
		'never creates near matches for %s entries',
		label => {
			const entry = expected({
				label,
				summary: 'invoice retry duplicate balance',
			})
			const bug = finding({
				path: 'src/billing/refund.ts',
				title: entry.summary,
			})
			expect(
				toCaseScore({ expected: [entry], findings: [bug], lineWindow: 0 })
			).toEqual({
				found: [],
				missed: [],
				near: [],
				noise: [],
				unmatched: [bug],
			})
		}
	)
	test('near matches move entries out of missed and findings out of unmatched without increasing recall', () => {
		const direct = expected({ id: 'direct', line: 10 })
		const near = expected({
			id: 'near',
			summary: 'invoice retry duplicate balance',
		})
		const missed = expected({ id: 'missed', path: 'elsewhere/charge.ts' })
		const exact = finding({ line: direct.line, status: 'confirmed' })
		const sibling = finding({
			path: 'src/billing/refund.ts',
			title: near.summary,
			status: 'unverified',
		})
		const input = {
			expected: [direct, near, missed],
			findings: [exact],
			lineWindow: 0,
		}
		const before = toBenchTotals([{ score: toCaseScore(input), nits: 0 }])
		const after = toBenchTotals([
			{ score: toCaseScore({ ...input, findings: [exact, sibling] }), nits: 0 },
		])
		expect(before).toMatchObject({
			found: 1,
			missed: 2,
			near: 0,
			recall: 1 / 3,
		})
		expect(after).toMatchObject({
			found: 1,
			confirmed: 1,
			unverified: 0,
			missed: 1,
			near: 1,
			unmatched: 0,
			recall: before.recall,
		})
		expect(
			toBenchTotals([
				{
					score: toCaseScore({
						expected: [near],
						findings: [sibling],
						lineWindow: 0,
					}),
					nits: 0,
				},
			])
		).toMatchObject({ found: 0, near: 1, missed: 0, recall: 0 })
	})
	test('totals split found statuses across cases without counting noise, near or unmatched statuses', () => {
		const entry = expected({ summary: 'invoice retry duplicate balance' })
		const cases = (['confirmed', 'unverified', 'unvalidated'] as const).map(
			status => ({
				nits: 1,
				score: toCaseScore({
					expected: [
						entry,
						expected({ id: 'noise', line: 10, label: 'false' }),
						expected({
							id: 'near',
							path: 'src/billing/near.ts',
							summary: entry.summary,
						}),
					],
					findings: [
						finding({ line: entry.line, status }),
						finding({ line: 10, status: 'confirmed' }),
						finding({
							path: 'src/billing/sibling.ts',
							title: entry.summary,
							status: 'unverified',
						}),
						finding({ path: 'elsewhere/a.ts', status: 'confirmed' }),
					],
					lineWindow: 0,
				}),
			})
		)
		expect(toBenchTotals(cases)).toEqual({
			cases: 3,
			found: 3,
			confirmed: 1,
			unverified: 1,
			near: 3,
			missed: 0,
			noise: 3,
			unmatched: 3,
			nits: 3,
			recall: 0.5,
			unmatchedPerCase: 1,
		})
	})
})
