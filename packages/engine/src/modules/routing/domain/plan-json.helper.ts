import type { ChangeShape } from '@mng-review/domain'
import type { PlanReport } from './plan-report.types'

/** The measured change shape with its verdict, or `null` when the plan did not measure it. */
function toShapeJson(shape: ChangeShape | undefined) {
	if (!shape) return null
	return { ...shape, mechanical: shape.failed.length === 0 }
}

/**
 * The plan as a JSON value: refs, rules, risk with its shape, depth, router, runs, skips, files and
 * tokens. `mng-review plan --json`, `mng-review --json` and the workflow's result file share it.
 */
export function toPlanJson(report: PlanReport) {
	const { change, plan } = report
	return {
		base: change.base,
		head: change.head,
		mergeBase: change.mergeBase,
		rules: report.rulesSource,
		skipped: plan.skippedRun ?? null,
		risk: {
			level: plan.risk,
			source: plan.riskSource,
			riskPaths: plan.riskPathHits,
			shape: toShapeJson(plan.shape),
		},
		depth: { level: plan.depth, source: plan.depthSource },
		router: plan.router,
		runs: plan.runs,
		skips: plan.skips,
		files: change.files,
		tokens: report.tokens,
	}
}
