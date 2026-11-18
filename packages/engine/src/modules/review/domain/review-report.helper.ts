import type { Validation } from '@mng-review/domain'
import type { PlanReport } from '../../routing/domain/plan-report.types'
import type {
	AgentRunReport,
	IncompleteRun,
	ReviewReport,
} from './review-report.types'

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
		tokenSources: {},
		droppedModels: [],
		wallMillis,
		blocking: false,
	}
}

/** What a run's token budget stopped: the finder reports and the validations. */
export interface BudgetStops {
	readonly agents: readonly AgentRunReport[]
	readonly validations: readonly Validation[]
	readonly tokensPerRun: number
}

/**
 * The run's incomplete marker: every finder or unit the token budget stopped (`agent` or
 * `agent: unit`) and the validations it skipped; `undefined` when nothing stopped.
 */
export function toIncompleteRun(stops: BudgetStops): IncompleteRun | undefined {
	const finders = stops.agents.flatMap(agent =>
		(agent.unfinished ?? []).map(unit =>
			unit === agent.name ? agent.name : `${agent.name}: ${unit}`
		)
	)
	const skipped = stops.validations.filter(
		validation => validation.status === 'unvalidated' && validation.budgetSpent
	).length
	const unfinished = [
		...finders,
		...(skipped > 0 ? [`validation of ${skipped} finding(s)`] : []),
	]
	if (unfinished.length === 0) return undefined
	return {
		reason: `limits.tokens_per_run (${stops.tokensPerRun}) reached`,
		unfinished,
	}
}
