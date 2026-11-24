import type { PublishReport } from '../application/publish-run.service'
import type { RiskReport } from '../application/risk-run.service'

/** What the rating did, in one clause; `undefined` when the rules do not ask for one. */
function toRiskText(risk: RiskReport): string | undefined {
	if (risk.status === 'off') return undefined
	if (risk.status === 'refused') return risk.reason
	if (risk.status === 'failed') return `stopped before step 1: ${risk.reason}`
	if (risk.status === 'none') return 'nothing to raise'
	const { result } = risk
	const label = result.labelFailed ? ', a label write failed' : ''
	const stands = result.grantStands
		? ', the grant may stand until the cleanup step'
		: ''
	if (result.state === 'error')
		return `not rated (${result.reason ?? 'unknown'}), error at ${result.level}${label}${stands}`
	if (result.state === 'none') return `nothing written${label}`
	return `${result.state} at ${result.level}${label}`
}

/** The publish text with the rating's clause after it, when the run has one. */
export function withRiskText(text: string, report: PublishReport): string {
	const risk = 'risk' in report ? report.risk : undefined
	const clause = risk ? toRiskText(risk) : undefined
	return clause === undefined ? text : `${text}; risk: ${clause}`
}
