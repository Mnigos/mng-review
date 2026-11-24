import { getSeverityRank } from '@mng-review/domain'
import type { ReviewReport, TokensByModel } from '@mng-review/engine'
import { escapeMarkdown, toCodeSpan } from '../../../utils/markdown.util'
import type { RatingBlock } from '../../risk/domain/risk.types'
import { formatRatingBlock } from '../../risk/presentation/rating-block.formatter'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import { MARKER_PREFIX, SHORT_SHA_LENGTH } from '../domain/publish.constants'
import type {
	AppliedReply,
	BotThread,
	PlannedThread,
	PublishPlan,
	ResolvedThread,
} from '../domain/publish.types'
import { toFindingBodyLines } from './finding-body.formatter'
import {
	toAgentRows,
	toRiskSource,
	toRunNotes,
} from './summary-agents.formatter'
import {
	type BlobLinks,
	toKindLabel,
	toKindTag,
	toMarkerComment,
	toSeverityLabel,
} from './thread-comment.formatter'

export const VERDICTS = [
	'ready',
	'needs fixes',
	'needs owner',
	'incomplete',
] as const
export type Verdict = (typeof VERDICTS)[number]
const TOKENS_PER_K = 1000
/** Entries a list shows before it says how many more there are. */
export const MAX_LIST_ITEMS = 25
/** Entries a list shows when the full summary is too long. */
export const SHORT_LIST_ITEMS = 3
/** Characters of a title, place or reason a summary list line keeps. */
const MAX_TEXT_CHARS = 300
/**
 * The longest summary body; GitHub refuses review bodies and comments over 65,536 characters, and
 * the margin keeps the verdict and the marker in.
 */
export const MAX_SUMMARY_CHARS = 60_000
/** The summary marker that ends a body; any other HTML comment in the body is kept. */
const SUMMARY_MARKER_AT_END = new RegExp(
	String.raw`<!-- ${MARKER_PREFIX}summary \{[^\n]*\} -->\s*$`,
	'u'
)

/** What the summary of a reviewed run shows. */
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
	/** Authors' replies this run answered; none when unset. */
	readonly answered?: readonly AppliedReply[]
	/** Threads that wait for the owner; none when unset. */
	readonly waiting?: readonly BotThread[]
	/** Tokens of the whole job, the re-check and the reply decisions included. */
	readonly tokens: TokensByModel
	readonly rating?: RatingBlock
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
	const label = `- ${toKindTag(kind, finding.severity)}`
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
		...toFindingBodyLines(finding, links, 'summary'),
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
	const { plan, report, links, answered = [], waiting = [] } = input
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
		...toWaitingSection(waiting, limit),
		...toSection(
			`Closed by this run, no longer found at the head (${input.resolved.length}):`,
			toCapped(
				input.resolved,
				limit,
				entry =>
					`${toThreadLine(entry.thread)}: ${escapeMarkdown(toShortText(entry.reason))}`
			)
		),
		...toSection(
			`Replies answered by this run (${answered.length}):`,
			toCapped(
				answered,
				limit,
				entry => `${toThreadLine(entry.thread)}: ${entry.decision.action}`
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

/** The threads that wait for the owner as a titled section, left out when none waits. */
export function toWaitingSection(
	waiting: readonly BotThread[],
	limit: number
): string[] {
	return toSection(
		`Waiting for the owner (${waiting.length}):`,
		toCapped(waiting, limit, toThreadLine)
	)
}

/** One of the bot's threads as a list line: its place and title. */
function toThreadLine(thread: BotThread): string {
	return `- ${toCodeSpan(`${thread.path}:${thread.line ?? thread.originalLine ?? thread.marker.line}`)} ${escapeMarkdown(toShortText(thread.marker.title))}`
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

/** The footer: the reviewed head and the engine commit. */
function toFooter(links: BlobLinks): string {
	const engine = links.engineCommit
		? `engine ${toCodeSpan(links.engineCommit.slice(0, SHORT_SHA_LENGTH))}`
		: 'engine unknown'
	return `<sub>Head ${toCodeSpan(links.head.slice(0, SHORT_SHA_LENGTH))} · ${engine}</sub>`
}

/** How much of the summary to show. */
interface SummaryDepth {
	readonly limit: number
	readonly details: boolean
}

/** The agents that ran and the tokens per model, collapsed below the findings. */
function toAgentDetails(input: SummaryInput): string[] {
	return [
		'',
		'<details><summary>Agents and tokens</summary>',
		'',
		...toAgentRows(input.report),
		'',
		toTokenLine(input.tokens),
		'',
		'</details>',
	]
}

/**
 * The summary with lists cut to the depth's limit, the verdict line first and the new findings
 * next; without details, only the verdict and the footer.
 */
function toSummaryBody(input: SummaryInput, depth: SummaryDepth): string {
	const body = depth.details
		? [
				...toFindingLines(input, depth.limit),
				...toRejectedLines(input.report, depth.limit),
				...toRunNotes(input.report, depth.limit),
				...toAgentDetails(input),
			]
		: ['', 'The details did not fit in one review; the job summary has them.']
	return [
		toVerdictLine(input),
		...(input.rating ? formatRatingBlock(input.rating) : []),
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
 * The summary of a reviewed run, the body of its review: verdict, risk and why, run count, the new
 * threads and what stayed in the summary (findings without a thread in full, collapsed), rejected
 * findings collapsed, what did not finish, then the agents with their results and why they ran and
 * the tokens per model, collapsed, and the hidden marker. Lists shrink until the body fits
 * `MAX_SUMMARY_CHARS`.
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

/** The summary when the run did not review and no summary exists yet: one status line. */
export function formatStatusComment(
	status: string,
	marker: SummaryMarker,
	links: BlobLinks
): string {
	return [
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
