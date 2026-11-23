import type { KeptFinding } from '@mng-review/domain'
import type { AgentRunReport } from '@mng-review/engine'
import { escapeMarkdown, toCodeSpan } from '../../../utils/markdown.util'
import { toKindTag } from '../../publish/presentation/thread-comment.formatter'

/** A check run's name for an agent: `MNG Review · <agent>`. */
export function toCheckName(agent: string): string {
	return `MNG Review · ${agent}`
}

/** A check's one-line title: how the agent ended and its findings by count. */
export function formatCheckTitle(
	agent: AgentRunReport | undefined,
	findings: readonly KeptFinding[]
): string {
	if (!agent) return 'not run'
	if (agent.status !== 'ok')
		return `${agent.status}, ${findings.length} finding(s)`
	if (findings.length === 0) return 'clean'
	return `${findings.length} finding(s)`
}

/** A check's summary: one escaped line per finding, then where the full text is. */
export function formatCheckSummary(findings: readonly KeptFinding[]): string {
	if (findings.length === 0) return 'No findings.'
	return [
		...findings.map(
			finding =>
				`- ${toKindTag(finding.kind === 'nit' ? 'nit' : finding.validation?.status === 'unverified' ? 'unverified' : 'bug', finding.severity)} ${toCodeSpan(`${finding.path}:${finding.line}`)} ${escapeMarkdown(finding.title)}`
		),
		'',
		'The threads and the summary comment on the pull request have the details.',
	].join('\n')
}
