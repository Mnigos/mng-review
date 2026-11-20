import { getSeverityRank } from '@mng-review/domain'
import type { ReviewReport, TokensByModel } from '@mng-review/engine'
import { escapeMarkdown, toCodeSpan } from '../../../utils/markdown.util'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import { MARKER_PREFIX, SHORT_SHA_LENGTH } from '../domain/publish.constants'
import type {
	PlannedThread,
	PublishPlan,
	ResolvedThread,
} from '../domain/publish.types'
import { toAgentRows, toRiskSource } from './summary-agents.formatter'
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
/** Characters of a title, place or reason a summary list line keeps. */
const MAX_TEXT_CHARS = 300
/**
 * The longest summary body; GitHub refuses comments over 65,536 characters, and the margin keeps
 * the verdict and the marker in.
 */
export const MAX_SUMMARY_CHARS = 60_000
/** The summary marker that ends a body; any other HTML comment in the body is kept. */
const SUMMARY_MARKER_AT_END = new RegExp(
	String.raw`<!-- ${MARKER_PREFIX}summary \{[^\n]*\} -->\s*$`,
	'u'
)

/** What the sticky summary of a reviewed run shows. */
export interface SummaryInput {
	readonly report: ReviewReport
	readonly plan: PublishPlan
	readonly verdict: Verdict
	readonly openBugs: number
	/** Of `openBugs`, the bugs without a thread earlier runs left on this head since the last full review. */
	readonly carriedBugs?: number
	readonly marker: SummaryMarker
	readonly maxRuns: number
	readonly links: BlobLinks
	/** Threads this run resolved after checking them again. */
	readonly resolved: readonly ResolvedThread[]
	/** Tokens of the whole job, the re-check included. */
	readonly tokens: TokensByModel
}

/** The verdict line: verdict, risk and why, open bugs and the run count. */
function toVerdictLine(input: SummaryInput): string {
	const { plan } = input.report.planReport
	return `**Verdict: ${input.verdict}** · risk ${plan.risk} (${toRiskSource(input.report)}) · ${input.openBugs} open bug thread(s) · run ${input.marker.runs} of ${input.maxRuns}`
}

/** At most `limit` lines, then one saying how many were left out. */
function toCapped<TItem>(
	items: readonly TItem[],
	limit: number,
	toLine: (item: TItem) => string
): string[] {
	const lines = items.slice(0, limit).map(toLine)
	if (items.length <= limit) return lines
	return [...lines, `- and ${items.length - limit} more`]
}

/** A finding to list, with its place when it has one. */
type ListedFinding = Pick<PlannedThread, 'finding' | 'kind'> &
	Partial<Pick<PlannedThread, 'place'>>

/** A finding as one list line: kind, place and title; a finding about the pull request has no place. */
function toFindingLine(thread: ListedFinding): string {
	const { finding, kind } = thread
	const label = `- **${toKindLabel(kind, finding.severity)}**`
	const title = escapeMarkdown(toShortText(finding.title))
	if (thread.place === 'pull_request') return `${label} ${title}`
	return `${label} ${toCodeSpan(toShortText(`${finding.path}:${finding.line}`))} ${title}`
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

/** Collapsed findings up to the limit, then how many more there are. */
function toCollapsedFindings(
	threads: readonly PlannedThread[],
	limit: number,
	links: BlobLinks
): string[] {
	return [
		...threads
			.slice(0, limit)
			.flatMap((thread, index) => toCollapsedFinding(thread, index, links)),
		...(threads.length > limit ? [`- and ${threads.length - limit} more`] : []),
	]
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
	const aboutPullRequest = threads.filter(
		thread => thread.place === 'pull_request'
	)
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
			toCapped(posted, limit, toFindingLine)
		),
		...toSection(
			`About the pull request (${aboutPullRequest.length}):`,
			toCollapsedFindings(aboutPullRequest, limit, links)
		),
		...toSection(
			`Not in the diff (${inSummary.length}):`,
			toCollapsedFindings(inSummary, limit, links)
		),
		...toSection(
			`Could not be posted, retried on the next run (${unposted.length}):`,
			toCapped(unposted, limit, toFindingLine)
		),
		...(plan.repeated.length === 0
			? []
			: [
					'',
					`${plan.repeated.length} finding(s) already have a thread and were not posted again.`,
				]),
		...toSection(
			`Closed by this run, no longer found at the head (${input.resolved.length}):`,
			toCapped(
				input.resolved,
				limit,
				entry =>
					`- ${toCodeSpan(`${entry.thread.path}:${entry.thread.line ?? entry.thread.originalLine ?? entry.thread.marker.line}`)} ${escapeMarkdown(toShortText(entry.thread.marker.title))}: ${escapeMarkdown(toShortText(entry.reason))}`
			)
		),
		...toSection(
			`Found again under threads resolved without a code change, not blocking (${plan.dismissed.length}):`,
			toCapped(plan.dismissed, limit, toFindingLine)
		),
		...toSection(
			`Below the severity floor (${below.length}):`,
			toCapped(below, limit, finding =>
				toFindingLine({
					finding,
					kind:
						finding.validation?.status === 'unverified' ? 'unverified' : 'bug',
				})
			)
		),
		...toSection(
			`Nits not posted inline (${plan.summaryNits.length}):`,
			toCapped(plan.summaryNits, limit, finding =>
				toFindingLine({ finding, kind: 'nit' })
			)
		),
	]
}

/** Model text cut to `MAX_TEXT_CHARS` before it is escaped, so a list line stays short. */
function toShortText(text: string): string {
	return text.length > MAX_TEXT_CHARS
		? `${text.slice(0, MAX_TEXT_CHARS)}…`
		: text
}

/** Rejected findings, collapsed, each with the validator's reason. */
function toRejectedLines(report: ReviewReport, limit: number): string[] {
	if (report.rejected.length === 0) return []
	return [
		'',
		`<details><summary>${report.rejected.length} finding(s) rejected by the validator</summary>`,
		'',
		...toCapped(
			report.rejected,
			limit,
			finding =>
				`- ${toSeverityLabel(finding.severity)} ${toCodeSpan(toShortText(`${finding.path}:${finding.line}`))} ${escapeMarkdown(toShortText(finding.title))}: ${escapeMarkdown(toShortText(finding.reason))}`
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
function toTokenLine(tokens: TokensByModel): string {
	const entries = Object.entries(tokens)
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
				toTokenLine(input.tokens),
			]
		: ['', 'The details did not fit in one comment; the job summary has them.']
	return [
		SUMMARY_HEADING,
		'',
		toVerdictLine(input),
		...(input.carriedBugs
			? [
					'',
					`${input.carriedBugs} bug(s) without a thread from earlier runs on this head still count until a full review checks them again.`,
				]
			: []),
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

/** An existing summary with only its final marker replaced; the text a reader sees stays as it was. */
export function toSummaryWithMarker(
	body: string,
	marker: SummaryMarker
): string {
	const replacement = toMarkerComment('summary', marker)
	const match = SUMMARY_MARKER_AT_END.exec(body)
	return match
		? `${body.slice(0, match.index)}${replacement}`
		: `${body}\n\n${replacement}`
}

/** An existing summary whose marker says the last run did not finish, its run count and head kept. */
export function toUnfinishedSummary(
	body: string,
	marker: SummaryMarker
): string {
	return toSummaryWithMarker(body, { ...marker, finished: false })
}
