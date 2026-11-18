import type { KeptFinding, RejectedFinding } from '@mng-review/domain'
import type { AgentRunReport, ReviewReport } from '@mng-review/engine'
import { formatPlanText, toPlanJson } from './plan.formatter'

const MILLIS_PER_SECOND = 1000

/** Milliseconds as seconds with one decimal. */
function toSeconds(millis: number): string {
	return `${(millis / MILLIS_PER_SECOND).toFixed(1)} s`
}

/** The validator's answer under a kept bug. */
function toValidationLines(finding: KeptFinding): string[] {
	const { validation } = finding
	if (validation?.status === 'confirmed')
		return [
			`    validator (${validation.model}): confirmed. ${validation.reason}`,
			...validation.evidence.map(line => `      ${line}`),
		]
	if (validation?.status === 'unvalidated' && validation.budgetSpent)
		return ['    validator: not run, token budget spent; kept unvalidated']
	if (validation?.status === 'unvalidated')
		return [
			`    validator: no answer after two attempts, kept (${validation.error})`,
		]
	return []
}

/** The suggested fix, its later lines indented under the first. */
function toSuggestionLines(finding: KeptFinding): string[] {
	if (!finding.suggestion) return []
	return [`    suggestion: ${finding.suggestion.replaceAll('\n', '\n      ')}`]
}

/** A kept bug: severity, place, title, who reported it, trigger, impact, evidence and validation. */
function toBugLines(finding: KeptFinding): string[] {
	const was = finding.reportedSeverity
		? ` (reported ${finding.reportedSeverity})`
		: ''
	return [
		`  ${finding.severity.toUpperCase()}${was}  ${finding.path}:${finding.line}  ${finding.title}`,
		`    agents: ${finding.agents.join(', ')}; models: ${finding.models.join(', ')}; fingerprint ${finding.fingerprint}`,
		`    trigger: ${finding.trigger}`,
		`    impact: ${finding.impact}`,
		...finding.evidence.map(line => `    evidence: ${line}`),
		...toValidationLines(finding),
		...toSuggestionLines(finding),
	]
}

/** A nit: place, title, agents and placement, then what it asks for and why. */
function toNitLines(finding: KeptFinding): string[] {
	const summary = finding.placement === 'summary' ? ' (summary)' : ''
	return [
		`  ${finding.path}:${finding.line}  ${finding.title} [${finding.agents.join(', ')}]${summary}`,
		`    trigger: ${finding.trigger}`,
		`    impact: ${finding.impact}`,
		...finding.evidence.map(line => `    evidence: ${line}`),
		...toSuggestionLines(finding),
	]
}

/** A rejected bug with the model that rejected it and why. */
function toRejectedLines(finding: RejectedFinding): string[] {
	return [
		`  ${finding.severity}  ${finding.path}:${finding.line}  ${finding.title} [${finding.agents.join(', ')}]`,
		`    models: ${finding.models.join(', ')}`,
		`    rejected by ${finding.validatedBy}: ${finding.reason}`,
		...finding.evidence.map(line => `    evidence: ${line}`),
	]
}

/** One agent run: status, model, tool calls, findings, units, fallback and time. */
function toAgentLine(agent: AgentRunReport): string {
	const units = agent.units ? `, ${agent.units} units` : ''
	const malformed = agent.malformed
		? `, ${agent.malformed} malformed dropped`
		: ''
	const fallback = agent.fellBackFrom
		? `; ${agent.fellBackFrom} was dropped`
		: ''
	const unfinished = agent.unfinished
		? `; did not finish: ${agent.unfinished.join(', ')}`
		: ''
	const error = agent.error ? `; ${agent.error}` : ''
	return `  ${agent.name}  ${agent.status}, ${agent.model} ${agent.effort}, ${agent.toolCalls} tool calls, ${agent.findings} findings${units}${malformed}, ${toSeconds(agent.wallMillis)}${fallback}${unfinished}${error}`
}

/** A titled section, left out when it has no lines. */
function toSection(title: string, lines: readonly string[]): string[] {
	return lines.length === 0 ? [] : ['', title, ...lines]
}

/** Findings, nits, rejected bugs, agents, tokens, dropped models and wall time. */
function toOutcomeLines(report: ReviewReport): string[] {
	const inline = report.bugs.filter(bug => bug.placement === 'inline')
	const below = report.bugs.filter(bug => bug.placement === 'summary')
	const inlineNits = report.nits.filter(nit => nit.placement === 'inline')
	return [
		'',
		`Bugs (${inline.length}):`,
		...(inline.length === 0 ? ['  (none)'] : inline.flatMap(toBugLines)),
		...toSection(
			`Below the severity floor (${below.length}):`,
			below.flatMap(toBugLines)
		),
		...toSection(
			`Nits (${inlineNits.length} inline, ${report.nits.length - inlineNits.length} in the summary):`,
			report.nits.flatMap(toNitLines)
		),
		...toSection(
			`Rejected by the validator (${report.rejected.length}):`,
			report.rejected.flatMap(toRejectedLines)
		),
		...toSection('Agents:', report.agents.map(toAgentLine)),
		...toSection(
			'Tokens:',
			Object.entries(report.tokens).map(
				([model, entry]) =>
					`  ${model}  ${entry.totalTokens} (${entry.inputTokens} in, ${entry.outputTokens} out, ${entry.calls} call(s))`
			)
		),
		...toSection(
			'Degraded run, models dropped:',
			report.droppedModels.map(drop => `  ${drop.model}  ${drop.reason}`)
		),
		...toSection(
			report.incomplete
				? `Incomplete run, ${report.incomplete.reason}; the findings above are partial. Did not finish:`
				: '',
			report.incomplete?.unfinished.map(entry => `  ${entry}`) ?? []
		),
		'',
		`Wall time: ${toSeconds(report.wallMillis)}`,
		...(report.endpointError
			? [`Endpoint error: ${report.endpointError}`]
			: []),
	]
}

/** The review as text: the plan, then the outcome. A skipped run prints the plan only. */
export function formatReviewText(report: ReviewReport): string {
	const plan = formatPlanText({ ...report.planReport, tokens: {} })
	if (report.planReport.plan.skippedRun) return plan
	return [plan, ...toOutcomeLines(report)].join('\n')
}

/** The review as a JSON document: the plan's fields and the outcome. */
export function formatReviewJson(report: ReviewReport): string {
	const { planReport, ...outcome } = report
	return JSON.stringify(
		{
			...toPlanJson(planReport),
			...outcome,
			endpointError: report.endpointError ?? null,
			incomplete: report.incomplete ?? null,
		},
		null,
		2
	)
}
