import { normalizeRepoPath } from '../../utils/repo-path.util'
import type { Plan } from '../review-plan.types'
import type { Risk, RiskSignal } from '../routing.types'

/**
 * The router's risk signals that hold: each names one of `paths` (the reviewable changed files) and
 * gives a reason, trimmed and kept once per category and path. A signal on a file the change does
 * not touch is the model's guess about the change, not a reading of it, so it is dropped.
 */
export function getKnownSignals(
	signals: readonly RiskSignal[],
	paths: readonly string[]
): RiskSignal[] {
	const changed = new Set(paths)
	const kept: RiskSignal[] = []
	for (const signal of signals) {
		const path = normalizeRepoPath(signal.path)
		const reason = signal.reason.trim()
		if (!(path && changed.has(path) && reason)) continue
		if (
			kept.some(
				entry => entry.category === signal.category && entry.path === path
			)
		)
			continue
		kept.push({ category: signal.category, path, reason })
	}
	return kept
}

/**
 * The risk a router answer comes to: `risky` with at least one known signal, else `trivial` when the
 * router marked the change trivial, else `normal`. The model reports what it sees; the level follows
 * by rule, so a borderline impression cannot flip the depth between runs.
 */
export function getRouterRisk(
	signals: readonly RiskSignal[],
	trivial: boolean
): Risk {
	if (signals.length > 0) return 'risky'
	return trivial ? 'trivial' : 'normal'
}

/**
 * The files a deep review's later reviewer models review: the changed files under `risk_paths`,
 * else the files the router's signals name when the router made the change risky; empty means the
 * whole change.
 */
export function getFocusPaths(
	plan: Pick<Plan, 'riskPathHits' | 'riskSource' | 'router'>
): readonly string[] {
	if (plan.riskPathHits.length > 0) return plan.riskPathHits
	if (plan.riskSource !== 'router') return []
	return [...new Set((plan.router.signals ?? []).map(signal => signal.path))]
}
