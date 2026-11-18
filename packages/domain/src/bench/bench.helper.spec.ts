import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { ConfigError } from '../config/config.errors'
import { finding } from '../shared/mocks/domain-test.helper'
import type { BenchFile, ExpectedFinding } from './bench-file.schema'
import { BENCH_FILE_VERSION, DEFAULT_LINE_WINDOW } from './bench.constants'
import { getBenchCases, toBenchTotals, toCaseScore } from './bench.helper'

/** Allocates independent expected entries for matching tests. */
function expected(overrides: Partial<ExpectedFinding> = {}): ExpectedFinding {
	return {
		id: 'duplicate-charge',
		path: 'src/billing/charge.ts',
		line: 81,
		label: 'real',
		summary: 'A retry charges twice.',
		...overrides,
	}
}

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
			).toEqual({ found: [], missed: [entry], noise: [], unmatched: [bug] })
		})
	test('different paths never match even at the same line', () => {
		const entry = expected()
		const bug = finding({ path: 'src/billing/refund.ts', line: entry.line })
		expect(
			toCaseScore({
				expected: [entry],
				findings: [bug],
				lineWindow: DEFAULT_LINE_WINDOW,
			})
		).toEqual({ found: [], missed: [entry], noise: [], unmatched: [bug] })
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
			noise: [],
			unmatched: [adjacent],
		})
	})
	test('empty inputs give an empty score', () => {
		expect(toCaseScore({ expected: [], findings: [], lineWindow: 0 })).toEqual({
			found: [],
			missed: [],
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
			missed: 0,
			noise: 0,
			unmatched: 0,
			nits: 0,
			recall: null,
			unmatchedPerCase: null,
		})
	})
})
