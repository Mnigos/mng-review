import type { ReviewConfig } from '../config/review-config.schema'
import type { PlannedRun } from '../routing/review-plan.types'
import type { Depth } from '../routing/routing.types'

/** How much of the finders' tokens each planned run gets, relative to the others. */
export const RUN_TOKEN_WEIGHT = {
	REVIEWER: 4,
	BUG_AGENT: 2,
	NIT_AGENT: 1,
} as const

/**
 * Tokens a run plans to spend: `limits.tokens_by_depth` for its depth, never more than
 * `limits.tokens_per_run`.
 */
export function getPlannedTokens(
	limits: ReviewConfig['limits'],
	depth: Depth
): number {
	return Math.min(limits.tokens_per_run, limits.tokens_by_depth[depth])
}

/** A planned run's weight: the main reviewer, a bug agent or a nit agent. */
function getRunWeight(run: Pick<PlannedRun, 'role' | 'kind'>): number {
	if (run.role === 'reviewer') return RUN_TOKEN_WEIGHT.REVIEWER
	return run.kind === 'bug'
		? RUN_TOKEN_WEIGHT.BUG_AGENT
		: RUN_TOKEN_WEIGHT.NIT_AGENT
}

/**
 * Splits the finders' tokens over the planned runs by weight, in plan order, so the runs together
 * plan to spend `finderTokens` whatever the number of agents.
 */
export function toRunAllowances(
	runs: readonly Pick<PlannedRun, 'role' | 'kind'>[],
	finderTokens: number
): number[] {
	const weights = runs.map(getRunWeight)
	const total = weights.reduce((sum, weight) => sum + weight, 0)
	if (total === 0) return []
	return weights.map(weight => Math.floor((finderTokens * weight) / total))
}
