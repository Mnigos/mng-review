import {
	type AgentsByName,
	type Finding,
	getSeverityFloor,
	getTitleWords,
	isAtLeast,
	NEAR_LINES,
	type ReviewConfig,
	type ReviewOutcome,
	SAME_TITLE_OVERLAP,
} from '@mng-review/domain'
import type { ThreadKind } from './publish-marker.schema'
import type {
	BotThread,
	CommentableLines,
	PlannedThread,
	PublishedFinding,
	PublishPlan,
	ThreadPlace,
} from './publish.types'

/** Which thread kinds already cover a finding of a kind: a confirmed bug only a bug thread. */
const COVERED_BY = {
	bug: ['bug'],
	unverified: ['bug', 'unverified'],
	nit: ['nit'],
} as const satisfies Record<ThreadKind, readonly ThreadKind[]>

/** What decides which findings a run publishes. */
export interface PublishSelection {
	readonly outcome: ReviewOutcome
	readonly config: ReviewConfig
	readonly agents: AgentsByName
}

/**
 * The findings that get a thread: bugs placed inline, unverified bugs at or above their severity
 * floor (posted as their own, never blocking kind) and nits placed inline. The rest stay in the
 * summary.
 */
export function getPublishedFindings(
	selection: PublishSelection
): PublishedFinding[] {
	const { outcome, config, agents } = selection
	const bugs = outcome.bugs.flatMap((finding): PublishedFinding[] => {
		if (finding.placement === 'inline') return [{ finding, kind: 'bug' }]
		if (
			finding.validation?.status === 'unverified' &&
			isAtLeast(finding.severity, getSeverityFloor(finding, config, agents))
		)
			return [{ finding, kind: 'unverified' }]
		return []
	})
	const nits = outcome.nits
		.filter(finding => finding.placement === 'inline')
		.map((finding): PublishedFinding => ({ finding, kind: 'nit' }))
	return [...bugs, ...nits]
}

/** Title word overlap (Jaccard) of two titles. */
function getTitleOverlap(a: string, b: string): number {
	const wordsA = new Set(getTitleWords(a))
	const wordsB = new Set(getTitleWords(b))
	const union = new Set([...wordsA, ...wordsB]).size
	if (union === 0) return 0
	return [...wordsA].filter(word => wordsB.has(word)).length / union
}

/**
 * True when the thread describes the finding's problem: the same fingerprint, or, for a thread on
 * a line of the head, the same path, a line at most `NEAR_LINES` away and similar titles. A thread
 * on a file, or an outdated one whose line left the diff, matches by fingerprint only, since its
 * old line number says nothing about the head.
 */
export function isSameProblem(finding: Finding, thread: BotThread): boolean {
	if (thread.marker.fingerprint === finding.fingerprint) return true
	if (thread.onFile || thread.path !== finding.path) return false
	if (
		thread.line === undefined ||
		Math.abs(thread.line - finding.line) > NEAR_LINES
	)
		return false
	return (
		getTitleOverlap(thread.marker.title, finding.title) >= SAME_TITLE_OVERLAP
	)
}

/**
 * The bot's threads that cover a finding: the same problem, of a kind at least as strong, so an
 * unverified thread never stands in for a confirmed bug.
 */
export function getMatchingThreads(
	published: PublishedFinding,
	threads: readonly BotThread[]
): BotThread[] {
	const kinds: readonly ThreadKind[] = COVERED_BY[published.kind]
	return threads.filter(
		thread =>
			kinds.includes(thread.marker.kind) &&
			isSameProblem(published.finding, thread)
	)
}

/** Where a new finding goes: its line when the diff has it, its file when the diff has that, else the summary. */
function getPlace(
	finding: Pick<Finding, 'path' | 'line'>,
	lines: CommentableLines
): ThreadPlace {
	const fileLines = lines.get(finding.path)
	if (fileLines?.has(finding.line)) return 'line'
	return fileLines ? 'file' : 'summary'
}

/** Inputs of the plan besides the selection. */
export interface PlanContext {
	readonly threads: readonly BotThread[]
	readonly lines: CommentableLines
	/** Resolved threads whose finding's code changed since their commit, or where git cannot tell, by id. */
	readonly changedPlaces: ReadonlySet<string>
}

/**
 * Plans one run: a finding covered by an open thread of the bot is repeated; one covered only by
 * resolved threads whose code has not changed since is dismissed, listed in the summary and not
 * blocking; every other one gets a thread where the diff allows. Nits the engine placed in the
 * summary stay there.
 */
export function planPublish(
	selection: PublishSelection,
	context: PlanContext
): PublishPlan {
	const threads: PlannedThread[] = []
	const repeated: PublishedFinding[] = []
	const dismissed: PublishedFinding[] = []
	for (const published of getPublishedFindings(selection)) {
		const matches = getMatchingThreads(published, context.threads)
		const open = matches.some(thread => !thread.resolved)
		const unchanged = matches.some(
			thread => thread.resolved && !context.changedPlaces.has(thread.id)
		)
		if (open) repeated.push(published)
		else if (unchanged) dismissed.push(published)
		else
			threads.push({
				...published,
				place: getPlace(published.finding, context.lines),
			})
	}
	return {
		threads,
		repeated,
		dismissed,
		summaryNits: selection.outcome.nits.filter(
			finding => finding.placement === 'summary'
		),
	}
}

/** Open bug threads after the run: the bot's unresolved ones and the new bugs, wherever they went. */
export function countOpenBugs(
	plan: PublishPlan,
	threads: readonly BotThread[]
): number {
	const open = threads.filter(
		thread => !thread.resolved && thread.marker.kind === 'bug'
	).length
	return open + plan.threads.filter(thread => thread.kind === 'bug').length
}
