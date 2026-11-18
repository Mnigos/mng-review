import { DEFAULT_PRESET } from '../config/review-config.constants'
import { config, plannedRun } from '../shared/mocks/domain-test.helper'
import {
	getPlannedTokens,
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
