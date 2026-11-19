import { DEFAULT_PRESET } from '../config/review-config.constants'
import { config, plannedRun } from '../shared/mocks/domain-test.helper'
import {
	getPlannedTokens,
	getFocusShare,
	MIN_FOCUS_SHARE,
	RUN_TOKEN_WEIGHT,
	REVIEWER_MIN_SHARE,
	toRunAllowances,
} from './token-budget.helper'

describe('planned token budgets', () => {
	for (const depth of ['quick', 'balanced', 'deep'] as const) {
		test(`${depth} uses its preset allowance`, () => {
			expect(getPlannedTokens(DEFAULT_PRESET.limits, depth)).toBe(
				DEFAULT_PRESET.limits.tokens_by_depth[depth]
			)
		})
		test(`${depth} respects a smaller hard run cap`, () => {
			expect(
				getPlannedTokens(
					config({ limits: { tokens_per_run: 123 } }).limits,
					depth
				)
			).toBe(123)
		})
	}
	test('uses configured depth values below the hard cap', () => {
		const { limits } = config({
			limits: { tokens_by_depth: { quick: 7, balanced: 11, deep: 19 } },
		})
		expect(
			(['quick', 'balanced', 'deep'] as const).map(depth =>
				getPlannedTokens(limits, depth)
			)
		).toEqual([7, 11, 19])
	})
	test('splits reviewer, bug and nit weights in plan order', () => {
		const runs = [
			plannedRun(),
			plannedRun({ role: 'agent', kind: 'bug' }),
			plannedRun({ role: 'agent', kind: 'nit' }),
		]
		const weight =
			RUN_TOKEN_WEIGHT.REVIEWER +
			RUN_TOKEN_WEIGHT.BUG_AGENT +
			RUN_TOKEN_WEIGHT.NIT_AGENT
		expect(toRunAllowances(runs, weight * 100)).toEqual([
			RUN_TOKEN_WEIGHT.REVIEWER * 100,
			RUN_TOKEN_WEIGHT.BUG_AGENT * 100,
			RUN_TOKEN_WEIGHT.NIT_AGENT * 100,
		])
	})
	for (const tokens of [0, 1, 6, 101, 560_000])
		test(`floors shares without exceeding ${tokens} tokens`, () => {
			const shares = toRunAllowances(
				[
					plannedRun(),
					plannedRun(),
					plannedRun({ role: 'agent', kind: 'nit' }),
				],
				tokens
			)
			expect(shares.every(Number.isInteger)).toBeTruthy()
			expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(
				tokens
			)
			expect(shares).toEqual([
				Math.floor(
					(tokens * RUN_TOKEN_WEIGHT.REVIEWER) /
						(2 * RUN_TOKEN_WEIGHT.REVIEWER + RUN_TOKEN_WEIGHT.NIT_AGENT)
				),
				Math.floor(
					(tokens * RUN_TOKEN_WEIGHT.REVIEWER) /
						(2 * RUN_TOKEN_WEIGHT.REVIEWER + RUN_TOKEN_WEIGHT.NIT_AGENT)
				),
				Math.floor(
					(tokens * RUN_TOKEN_WEIGHT.NIT_AGENT) /
						(2 * RUN_TOKEN_WEIGHT.REVIEWER + RUN_TOKEN_WEIGHT.NIT_AGENT)
				),
			])
		})
	test('empty plans have no allowances', () =>
		expect(toRunAllowances([], 100)).toEqual([]))
	test('a lone finder receives the whole allowance', () =>
		expect(toRunAllowances([plannedRun()], 101)).toEqual([101]))
})

describe('reviewer least share', () => {
	test.each([1, 2, 3])(
		'%s reviewer runs share the floor and agents divide the rest by weight',
		reviewers => {
			const bugs = Array.from({ length: 12 }, () =>
				plannedRun({ role: 'agent', kind: 'bug' })
			)
			const runs = [
				plannedRun({ role: 'agent', kind: 'bug' }),
				...Array.from({ length: reviewers }, () => plannedRun()),
				...bugs.slice(1),
				plannedRun({ role: 'agent', kind: 'nit' }),
			]
			const tokens = 100_000
			const shares = toRunAllowances(runs, tokens)
			expect(shares.slice(1, reviewers + 1)).toEqual(
				Array.from({ length: reviewers }, () =>
					Math.floor((tokens * REVIEWER_MIN_SHARE) / reviewers)
				)
			)
			const weight =
				bugs.length * RUN_TOKEN_WEIGHT.BUG_AGENT + RUN_TOKEN_WEIGHT.NIT_AGENT
			const bugShare = Math.floor(
				(tokens * (1 - REVIEWER_MIN_SHARE) * RUN_TOKEN_WEIGHT.BUG_AGENT) /
					weight
			)
			expect([shares[0], ...shares.slice(reviewers + 1, -1)]).toEqual(
				bugs.map(() => bugShare)
			)
			expect(shares.at(-1)).toBe(
				Math.floor(
					(tokens * (1 - REVIEWER_MIN_SHARE) * RUN_TOKEN_WEIGHT.NIT_AGENT) /
						weight
				)
			)
			expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(
				tokens
			)
		}
	)
	test('reviewer-only runs divide the whole budget', () => {
		expect(toRunAllowances([plannedRun(), plannedRun()], 101)).toEqual([50, 50])
	})
	test('agent-only runs keep their weighted shares', () => {
		const weight = RUN_TOKEN_WEIGHT.BUG_AGENT + RUN_TOKEN_WEIGHT.NIT_AGENT
		expect(
			toRunAllowances(
				[
					plannedRun({ role: 'agent', kind: 'bug' }),
					plannedRun({ role: 'agent', kind: 'nit' }),
				],
				weight * 100
			)
		).toEqual([
			RUN_TOKEN_WEIGHT.BUG_AGENT * 100,
			RUN_TOKEN_WEIGHT.NIT_AGENT * 100,
		])
	})
	test('weights exactly at the floor remain weighted', () => {
		const agents = Array.from({ length: 3 }, () =>
			plannedRun({ role: 'agent', kind: 'bug' })
		)
		const total = RUN_TOKEN_WEIGHT.REVIEWER + 3 * RUN_TOKEN_WEIGHT.BUG_AGENT
		expect(toRunAllowances([plannedRun(), ...agents], total * 100)).toEqual([
			RUN_TOKEN_WEIGHT.REVIEWER * 100,
			...agents.map(() => RUN_TOKEN_WEIGHT.BUG_AGENT * 100),
		])
	})
})

describe('getFocusShare', () => {
	const files = [
		{ path: 'src/auth/session.guard.ts', additions: 10, deletions: 20 },
		{ path: 'src/data/record.ts', additions: 30, deletions: 40 },
	] as const

	test('uses additions and deletions across every file as the denominator', () => {
		expect(getFocusShare(files, ['src/auth/session.guard.ts'])).toBe(0.3)
		expect(getFocusShare(files, ['src/data/record.ts'])).toBe(0.7)
	})
	test('no focus paths means the whole allowance', () => {
		expect(getFocusShare(files, [])).toBe(1)
	})
	test('all changed paths means the whole allowance', () => {
		expect(
			getFocusShare(
				files,
				files.map(file => file.path)
			)
		).toBe(1)
	})
	test('repeated focus paths do not count changed lines twice', () => {
		expect(
			getFocusShare(files, [
				'src/auth/session.guard.ts',
				'src/auth/session.guard.ts',
			])
		).toBe(0.3)
	})
	test('a focus below the minimum receives the minimum share', () => {
		expect(
			getFocusShare(
				[
					{ path: 'small.ts', additions: 1, deletions: 0 },
					{ path: 'large.ts', additions: 99, deletions: 0 },
				],
				['small.ts']
			)
		).toBe(MIN_FOCUS_SHARE)
	})
	test('a focus exactly at the minimum keeps that share', () => {
		expect(
			getFocusShare(
				[
					{ path: 'focus.ts', additions: MIN_FOCUS_SHARE * 100, deletions: 0 },
					{
						path: 'other.ts',
						additions: (1 - MIN_FOCUS_SHARE) * 100,
						deletions: 0,
					},
				],
				['focus.ts']
			)
		).toBe(MIN_FOCUS_SHARE)
	})
	test('focus paths without changed lines still receive the minimum', () => {
		expect(getFocusShare(files, ['unchanged.ts'])).toBe(MIN_FOCUS_SHARE)
	})
	test('a binary-only or empty change keeps the whole allowance', () => {
		expect(
			getFocusShare(
				[{ path: 'image.bin', additions: 0, deletions: 0 }],
				['image.bin']
			)
		).toBe(1)
		expect(getFocusShare([], ['missing.ts'])).toBe(1)
	})
})
