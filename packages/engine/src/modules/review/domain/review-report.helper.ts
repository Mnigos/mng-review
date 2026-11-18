import type { PlanReport } from '../../routing/domain/plan-report.types'
import type { ReviewReport } from './review-report.types'

/** The report of a run that reviewed nothing: skipped by the gate or with no planned runs. */
export function toEmptyReviewReport(
	planReport: PlanReport,
	wallMillis: number
): ReviewReport {
	return {
		bugs: [],
		nits: [],
		rejected: [],
		planReport,
		agents: [],
		tokens: planReport.tokens,
		droppedModels: [],
		wallMillis,
		blocking: false,
	}
}
