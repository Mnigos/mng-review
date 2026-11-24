import { toPlanJson } from '../../routing/domain/plan-json.helper'
import type { ReviewReport } from './review-report.types'

/**
 * The review as a JSON value: the plan's fields, then the outcome with `null` for an absent
 * endpoint error or budget stop. The risk rating is `rating`, since `risk` is the plan's routing
 * risk; it is present only on a run that rates, so a run without one prints the same bytes as
 * before. `mng-review --json` prints it and the workflow's result file carries it under `review`.
 */
export function toReviewJson(report: ReviewReport) {
	const { planReport, ...outcome } = report
	return {
		...toPlanJson(planReport),
		...outcome,
		endpointError: report.endpointError ?? null,
		incomplete: report.incomplete ?? null,
	}
}
