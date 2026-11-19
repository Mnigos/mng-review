import { type PlannedRun, SEVERITIES } from '@mng-review/domain'
import type { AgentRunReport, ReviewReport } from '@mng-review/engine'
import { escapeMarkdown, toCodeSpan } from '../../../utils/markdown.util'

/** Risk signals the summary names before it stops. */
const MAX_SIGNALS = 3

/**
 * The report of one planned run, by name. A deep run plans the main reviewer once per reviewer
 * model; then the planned model picks the report: its own model, or the model it fell back from.
 */
export function getAgentReport(
	run: PlannedRun,
	agents: readonly AgentRunReport[]
): AgentRunReport | undefined {
	const named = agents.filter(agent => agent.name === run.name)
	if (named.length === 1) return named[0]
	return (
		named.find(agent => agent.fellBackFrom === run.model) ??
		named.find(agent => !agent.fellBackFrom && agent.model === run.model)
	)
}

/** Why a planned run ran: always, its path rules, or the router's reason. */
function toWhy(run: PlannedRun): string {
	if (run.selectedBy === 'router')
		return `router: ${escapeMarkdown(run.reason ?? '')}`
	return run.selectedBy === 'paths' ? 'path rules' : 'always'
}

/** A run's findings by severity, or how it ended when it did not finish. */
function toAgentResult(run: PlannedRun, report: ReviewReport): string {
	const agent = getAgentReport(run, report.agents)
	if (!agent) return 'not run'
	if (agent.status !== 'ok') return agent.status
	const own = [...report.bugs, ...report.nits].filter(finding =>
		finding.agents.includes(run.name)
	)
	if (own.length === 0) return 'clean'
	return SEVERITIES.toReversed()
		.map(severity => ({
			severity,
			count: own.filter(finding => finding.severity === severity).length,
		}))
		.filter(entry => entry.count > 0)
		.map(entry => `${entry.count} ${entry.severity}`)
		.join(', ')
}

/** What decided the risk: risky paths, a mechanical change, or the router and its signals. */
export function toRiskSource(report: ReviewReport): string {
	const { plan } = report.planReport
	if (plan.riskSource === 'risk_paths') return 'risk_paths'
	if (plan.riskSource === 'mechanical') return 'mechanical change'
	if (plan.riskSource !== 'router') return 'default'
	const signals = (plan.router.signals ?? []).slice(0, MAX_SIGNALS)
	if (signals.length === 0) return 'router'
	return `router: ${signals.map(signal => `${escapeMarkdown(signal.category)} in ${toCodeSpan(signal.path)}`).join(', ')}`
}

/** One table row per planned run; deep runs of the main reviewer appear once. */
export function toAgentRows(report: ReviewReport): string[] {
	const runs = report.planReport.plan.runs.filter(
		(run, index, all) =>
			all.findIndex(other => other.name === run.name) === index
	)
	return [
		'| Agent | Result | Why it ran |',
		'| --- | --- | --- |',
		...runs.map(
			run =>
				`| ${escapeMarkdown(run.name)} | ${toAgentResult(run, report)} | ${toWhy(run)} |`
		),
	]
}
