import {
	getSeverityRank,
	type PlannedRun,
	SEVERITIES,
} from '@mng-review/domain'
import type { AgentRunReport, ReviewReport } from '@mng-review/engine'
import { escapeMarkdown, toCodeSpan } from '../../../utils/markdown.util'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import { SHORT_SHA_LENGTH } from '../domain/publish.constants'
import type { PlannedThread, PublishPlan } from '../domain/publish.types'
import {
	type BlobLinks,
	toFindingDetailLines,
	toKindLabel,
	toMarkerComment,
	toSeverityLabel,
} from './thread-comment.formatter'

export const SUMMARY_HEADING = '## MNG Review'
export const VERDICTS = [
	'ready',
	'needs fixes',
	'needs owner',
	'incomplete',
] as const
export type Verdict = (typeof VERDICTS)[number]
const TOKENS_PER_K = 1000
/** Entries a list shows before it says how many more there are. */
const MAX_LIST_ITEMS = 25
/** Entries a list shows when the full summary is too long. */
const SHORT_LIST_ITEMS = 3
/** Characters of a rejection reason the summary keeps. */
const MAX_REASON_CHARS = 300
/**
 * The longest summary body; GitHub refuses comments over 65,536 characters, and the margin keeps
 * the verdict and the marker in.
 */
export const MAX_SUMMARY_CHARS = 60_000

/** What the sticky summary of a reviewed run shows. */
export interface SummaryInput {
	readonly report: ReviewReport
	readonly plan: PublishPlan
	readonly verdict: Verdict
	readonly openBugs: number
	readonly marker: SummaryMarker
	readonly maxRuns: number
	readonly links: BlobLinks
}

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
function toRiskSource(report: ReviewReport): string {
	const { plan } = report.planReport
	if (plan.riskSource === 'risk_paths') return 'risk_paths'
	if (plan.riskSource === 'mechanical') return 'mechanical change'
	if (plan.riskSource !== 'router') return 'default'
	const signals = (plan.router.signals ?? []).slice(0, SHORT_LIST_ITEMS)
	if (signals.length === 0) return 'router'
	return `router: ${signals.map(signal => `${escapeMarkdown(signal.category)} in ${toCodeSpan(signal.path)}`).join(', ')}`
}

/** The verdict line: verdict, risk and why, open bugs and the run count. */
function toVerdictLine(input: SummaryInput): string {
	const { plan } = input.report.planReport
	return `**Verdict: ${input.verdict}** · risk ${plan.risk} (${toRiskSource(input.report)}) · ${input.openBugs} open bug thread(s) · run ${input.marker.runs} of ${input.maxRuns}`
}

/** One table row per planned run; deep runs of the main reviewer appear once. */
function toAgentRows(report: ReviewReport): string[] {
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

/** At most `limit` lines, then one saying how many were left out. */
function toCapped(lines: readonly string[], limit: number): string[] {
	if (lines.length <= limit) return [...lines]
	return [...lines.slice(0, limit), `- and ${lines.length - limit} more`]
}

/** A finding as one list line: kind, place and title. */
function toFindingLine(
	thread: Pick<PlannedThread, 'finding' | 'kind'>
): string {
	const { finding, kind } = thread
	return `- **${toKindLabel(kind, finding.severity)}** ${toCodeSpan(`${finding.path}:${finding.line}`)} ${escapeMarkdown(finding.title)}`
}

/**
 * A finding that has no thread, collapsed, with everything its thread would have said. The
 * `<summary>` is raw HTML, where Markdown escapes do not apply, so it holds only fixed text; the
 * escaped title and place follow inside, where Markdown applies again.
 */
function toCollapsedFinding(
	thread: PlannedThread,
	index: number,
	links: BlobLinks
): string[] {
	const { finding, kind } = thread
	return [
		`<details><summary>${toKindLabel(kind, finding.severity)} finding ${index + 1}</summary>`,
		'',
		toFindingLine(thread),
		'',
		...toFindingDetailLines(finding, links, false),
		'',
		'</details>',
	]
}

/** A titled section, left out when empty. */
function toSection(title: string, lines: readonly string[]): string[] {
	return lines.length === 0 ? [] : ['', title, '', ...lines]
}

/** Most severe first. */
function bySeverity(a: PlannedThread, b: PlannedThread): number {
	return (
		getSeverityRank(b.finding.severity) - getSeverityRank(a.finding.severity)
	)
}

/** New threads, findings that could not get one, and what stays in the summary. */
function toFindingLines(input: SummaryInput, limit: number): string[] {
	const { plan, report, links } = input
	const threads = plan.threads.toSorted(bySeverity)
	const posted = threads.filter(
		thread => thread.place === 'line' || thread.place === 'file'
	)
	const inSummary = threads.filter(thread => thread.place === 'summary')
	const unposted = threads.filter(thread => thread.place === 'unposted')
	const published = new Set(
		[...plan.threads, ...plan.repeated, ...plan.dismissed].map(
			entry => entry.finding
		)
	)
	const below = report.bugs.filter(
		bug => bug.placement === 'summary' && !published.has(bug)
	)
	return [
		...toSection(
			`New threads (${posted.length}):`,
			toCapped(posted.map(toFindingLine), limit)
		),
		...toSection(
			`Not in the diff (${inSummary.length}):`,
			inSummary
				.slice(0, limit)
				.flatMap((thread, index) => toCollapsedFinding(thread, index, links))
		),
		...toSection(
			`Could not be posted, retried on the next run (${unposted.length}):`,
			toCapped(unposted.map(toFindingLine), limit)
		),
		...(plan.repeated.length === 0
			? []
			: [
					'',
					`${plan.repeated.length} finding(s) already have a thread and were not posted again.`,
				]),
		...toSection(
			`Found again under threads resolved without a code change, not blocking (${plan.dismissed.length}):`,
			toCapped(plan.dismissed.map(toFindingLine), limit)
		),
		...toSection(
			`Below the severity floor (${below.length}):`,
			toCapped(
				below.map(finding =>
					toFindingLine({
						finding,
						kind:
							finding.validation?.status === 'unverified'
								? 'unverified'
								: 'bug',
					})
				),
				limit
			)
		),
		...toSection(
			`Nits not posted inline (${plan.summaryNits.length}):`,
			toCapped(
				plan.summaryNits.map(finding =>
					toFindingLine({ finding, kind: 'nit' })
				),
				limit
			)
		),
	]
}

/** A reason cut to `MAX_REASON_CHARS`. */
function toShortReason(reason: string): string {
	return reason.length > MAX_REASON_CHARS
		? `${reason.slice(0, MAX_REASON_CHARS)}…`
		: reason
}

/** Rejected findings, collapsed, each with the validator's reason. */
function toRejectedLines(report: ReviewReport, limit: number): string[] {
	if (report.rejected.length === 0) return []
	return [
		'',
		`<details><summary>${report.rejected.length} finding(s) rejected by the validator</summary>`,
		'',
		...toCapped(
			report.rejected.map(
				finding =>
					`- ${toSeverityLabel(finding.severity)} ${toCodeSpan(`${finding.path}:${finding.line}`)} ${escapeMarkdown(finding.title)}: ${escapeMarkdown(toShortReason(finding.reason))}`
			),
			limit
		),
		'',
		'</details>',
	]
}

/** Skipped agents, units that did not finish, dropped models and an endpoint failure. */
function toRunNotes(report: ReviewReport, limit: number): string[] {
	const { skips } = report.planReport.plan
	const unfinished = [
		...report.agents
			.filter(agent => agent.status === 'failed')
			.map(agent => `${agent.name} failed`),
		...(report.incomplete?.unfinished ?? []),
		...report.droppedModels.map(drop => `model ${drop.model} dropped`),
	]
	const skipped = skips
		.slice(0, limit)
		.map(
			skip => `${escapeMarkdown(skip.name)} (${escapeMarkdown(skip.reason)})`
		)
	return [
		...(skipped.length === 0 ? [] : ['', `Skipped: ${skipped.join(', ')}`]),
		...(unfinished.length === 0
			? []
			: [
					'',
					`Did not finish: ${unfinished.slice(0, limit).map(escapeMarkdown).join(', ')}`,
				]),
		...(report.endpointError
			? [
					'',
					`The model endpoint failed: ${escapeMarkdown(report.endpointError)}`,
				]
			: []),
	]
}

/** Tokens in thousands, such as `318k`. */
function toThousands(tokens: number): string {
	return `${Math.round(tokens / TOKENS_PER_K)}k`
}

/** Tokens per model, in thousands. */
function toTokenLine(report: ReviewReport): string {
	const entries = Object.entries(report.tokens)
	if (entries.length === 0) return 'Tokens: none'
	return `Tokens: ${entries.map(([model, entry]) => `${escapeMarkdown(model)} ${toThousands(entry.totalTokens)}`).join(' · ')}`
}

/** The footer: head, engine and the rule that the bot only comments. */
function toFooter(links: BlobLinks): string {
	const engine = links.engineCommit
		? `engine ${toCodeSpan(links.engineCommit.slice(0, SHORT_SHA_LENGTH))}`
		: 'engine unknown'
	return `<sub>Head ${toCodeSpan(links.head.slice(0, SHORT_SHA_LENGTH))} · ${engine} · comments only, never an approval</sub>`
}

/** How much of the summary to show. */
interface SummaryDepth {
	readonly limit: number
	readonly details: boolean
}

/** The summary with lists cut to the depth's limit; without details, only the verdict and the footer. */
function toSummaryBody(input: SummaryInput, depth: SummaryDepth): string {
	const body = depth.details
		? [
				'',
				...toAgentRows(input.report),
				...toRunNotes(input.report, depth.limit),
				...toFindingLines(input, depth.limit),
				...toRejectedLines(input.report, depth.limit),
				'',
				toTokenLine(input.report),
			]
		: ['', 'The details did not fit in one comment; the job summary has them.']
	return [
		SUMMARY_HEADING,
		'',
		toVerdictLine(input),
		...body,
		'',
		toFooter(input.links),
		'',
		toMarkerComment('summary', input.marker),
	].join('\n')
}

/**
 * The sticky summary of a reviewed run: verdict, risk and why, run count, the agents with their
 * results and why they ran, the new threads and what stayed in the summary (findings without a
 * thread in full, collapsed), rejected findings collapsed, what did not finish, tokens per model,
 * and the hidden marker. Lists shrink until the body fits `MAX_SUMMARY_CHARS`.
 */
export function formatSummaryComment(input: SummaryInput): string {
	const full = toSummaryBody(input, { limit: MAX_LIST_ITEMS, details: true })
	if (full.length <= MAX_SUMMARY_CHARS) return full
	const short = toSummaryBody(input, {
		limit: SHORT_LIST_ITEMS,
		details: true,
	})
	if (short.length <= MAX_SUMMARY_CHARS) return short
	return toSummaryBody(input, { limit: 0, details: false })
}

/** The sticky summary when the run did not review and no summary exists yet. */
export function formatStatusComment(
	status: string,
	marker: SummaryMarker,
	links: BlobLinks
): string {
	return [
		SUMMARY_HEADING,
		'',
		escapeMarkdown(status),
		'',
		toFooter(links),
		'',
		toMarkerComment('summary', marker),
	].join('\n')
}
