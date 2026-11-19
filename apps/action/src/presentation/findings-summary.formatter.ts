import {
	type KeptFinding,
	type RejectedFinding,
	SEVERITIES,
	type Severity,
} from '@mng-review/domain'
import type { ReviewReport } from '@mng-review/engine'
import { escapeMarkdown, toCodeSpan } from '@mng-review/github'

/** Severities from the most severe down, the order findings are listed in. */
const SEVERITY_ORDER = SEVERITIES.toReversed()

/** Where a finding is: its path and line as code. */
function toPlace(finding: Pick<KeptFinding, 'path' | 'line'>): string {
	return toCodeSpan(`${finding.path}:${finding.line}`)
}

/** What the validator said about a kept bug, in a few words. */
function toValidationText(finding: KeptFinding): string {
	const { validation } = finding
	if (validation?.status === 'confirmed')
		return `confirmed by ${escapeMarkdown(validation.model)}`
	if (validation?.status === 'unverified')
		return `unverified by ${escapeMarkdown(validation.model)}, rests on: ${escapeMarkdown(validation.premise)}`
	if (validation?.status === 'unvalidated' && validation.budgetSpent)
		return 'not validated, token budget spent'
	if (validation?.status === 'unvalidated') return 'no validator answer, kept'
	return 'not validated'
}

/** One kept bug: place, title, who reported it, the validation and the re-rating, then why it matters. */
function toBugLines(finding: KeptFinding): string[] {
	const rerated = finding.reportedSeverity
		? `, reported ${finding.reportedSeverity}`
		: ''
	const floor =
		finding.placement === 'summary' &&
		finding.validation?.status !== 'unverified'
			? ', below the severity floor'
			: ''
	const { validation } = finding
	const judged =
		validation?.status === 'confirmed' || validation?.status === 'unverified'
			? validation
			: undefined
	return [
		`- ${toPlace(finding)} ${escapeMarkdown(finding.title)}`,
		`  - ${escapeMarkdown(finding.agents.join(', '))}; ${toValidationText(finding)}${rerated}${floor}`,
		...(judged?.loweredBecause
			? [`  - Lowered because: ${escapeMarkdown(judged.loweredBecause)}`]
			: []),
		...(judged?.note ? [`  - Note: ${escapeMarkdown(judged.note)}`] : []),
		`  - Trigger: ${escapeMarkdown(finding.trigger)}`,
		`  - Impact: ${escapeMarkdown(finding.impact)}`,
	]
}

/** Bugs grouped under one heading per severity, most severe first; nothing for an empty list. */
function toSeverityGroups(
	title: string,
	bugs: readonly KeptFinding[]
): string[] {
	if (bugs.length === 0) return []
	const groups = SEVERITY_ORDER.flatMap((severity: Severity) => {
		const group = bugs.filter(bug => bug.severity === severity)
		if (group.length === 0) return []
		return [
			'',
			`#### ${severity} (${group.length})`,
			'',
			...group.flatMap(toBugLines),
		]
	})
	return ['', `### ${title} (${bugs.length})`, ...groups]
}

/** A nit: place, title and the agent that asked for it. */
function toNitLine(finding: KeptFinding): string {
	return `- ${toPlace(finding)} ${escapeMarkdown(finding.title)} (${escapeMarkdown(finding.agents.join(', '))})`
}

/** A rejected bug and the validator's reason. */
function toRejectedLine(finding: RejectedFinding): string {
	return `- ${finding.severity} ${toPlace(finding)} ${escapeMarkdown(finding.title)}: rejected by ${escapeMarkdown(finding.validatedBy)}, ${escapeMarkdown(finding.reason)}`
}

/**
 * Findings of a review: bugs by severity (confirmed and unvalidated first, then the unverified
 * ones that rest on a dependency), nits, and the bugs the validator rejected, collapsed.
 */
export function toFindingsLines(report: ReviewReport): string[] {
	const unverified = report.bugs.filter(
		bug => bug.validation?.status === 'unverified'
	)
	const kept = report.bugs.filter(
		bug => bug.validation?.status !== 'unverified'
	)
	const rejected =
		report.rejected.length === 0
			? []
			: [
					'',
					'<details>',
					`<summary>Rejected by the validator (${report.rejected.length})</summary>`,
					'',
					...report.rejected.map(toRejectedLine),
					'',
					'</details>',
				]
	return [
		...(report.bugs.length === 0 ? ['', '### Bugs', '', 'None.'] : []),
		...toSeverityGroups('Bugs', kept),
		...toSeverityGroups(
			"Unverified, resting on a dependency's behaviour, never blocking",
			unverified
		),
		...(report.nits.length === 0
			? []
			: [
					'',
					`### Nits (${report.nits.length})`,
					'',
					...report.nits.map(toNitLine),
				]),
		...rejected,
	]
}
