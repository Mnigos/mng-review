import {
	type AgentsByName,
	type Finding,
	getFingerprints,
	getSeverityFloor,
	getTitleWords,
	isAtLeast,
	NEAR_LINES,
	type ReviewConfig,
	type ReviewOutcome,
	SAME_TITLE_OVERLAP,
} from '@mng-review/domain'
import { isOpenBug } from './bot-thread.helper'
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
 * True when the thread describes the finding's problem: one of the finding's fingerprints
 * (`getFingerprints`); for an open thread, the same path and line (its original line when
 * outdated) whatever the title, since the model rewords titles between runs; or, for a thread on a
 * line of the head, the same path, a line at most `NEAR_LINES` away and similar titles. A thread on
 * a file, and a resolved outdated one, match by fingerprint only, so a fixed bug that comes back on
 * a changed line is posted again.
 */
export function isSameProblem(finding: Finding, thread: BotThread): boolean {
	if (getFingerprints(finding).includes(thread.marker.fingerprint)) return true
	if (thread.onFile || thread.path !== finding.path) return false
	if (!thread.resolved && (thread.line ?? thread.originalLine) === finding.line)
		return true
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

/**
 * True when only metadata agents reported the finding: it is about the pull request, and the path
 * and line the model had to give name no place in the code.
 */
export function isPullRequestFinding(
	finding: Pick<Finding, 'agents'>,
	agents: AgentsByName
): boolean {
	return (
		finding.agents.length > 0 &&
		finding.agents.every(
			name => agents.get(name)?.frontMatter.input === 'metadata'
		)
	)
}

/**
 * Where a new finding goes: the summary when it is about the pull request, its line when the diff
 * has it, its file when the diff has that, else the summary.
 */
function getPlace(
	finding: Pick<Finding, 'agents' | 'path' | 'line'>,
	lines: CommentableLines,
	agents: AgentsByName
): ThreadPlace {
	if (isPullRequestFinding(finding, agents)) return 'pull_request'
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
	const summaryNits = selection.outcome.nits.filter(
		finding => finding.placement === 'summary'
	)
	// Nits the engine kept out of the threads but that are about the pull request go with the others.
	const threads: PlannedThread[] = summaryNits
		.filter(finding => isPullRequestFinding(finding, selection.agents))
		.map(finding => ({ finding, kind: 'nit', place: 'pull_request' }))
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
				place: getPlace(published.finding, context.lines, selection.agents),
			})
	}
	return {
		threads,
		repeated,
		dismissed,
		summaryNits: summaryNits.filter(
			finding => !isPullRequestFinding(finding, selection.agents)
		),
	}
}

/** Places whose thread is on GitHub. */
const THREAD_PLACES = ['line', 'file'] as const satisfies readonly ThreadPlace[]

/**
 * The plan with every new line or file thread moved into the summary, for a run whose list reads
 * left a node out: an unseen thread of the bot may hold the finding already, so no thread is posted
 * that could repeat it. The next run with complete reads posts the ones still new.
 */
export function toWithheldPlan(plan: PublishPlan): PublishPlan {
	return {
		...plan,
		threads: plan.threads.map(thread =>
			THREAD_PLACES.some(place => place === thread.place)
				? { ...thread, place: 'summary' }
				: thread
		),
	}
}

/** Fingerprints of the bot's open bug threads. */
function getHeldFingerprints(
	threads: readonly BotThread[]
): ReadonlySet<string> {
	return new Set(
		threads
			.filter(thread => !thread.resolved && thread.marker.kind === 'bug')
			.map(thread => thread.marker.fingerprint)
	)
}

/** True when an open bug thread holds one of the finding's fingerprints. */
function isHeld(
	finding: Pick<Finding, 'fingerprint' | 'cutTitleFingerprint'>,
	held: ReadonlySet<string>
): boolean {
	return getFingerprints(finding).some(fingerprint => held.has(fingerprint))
}

/**
 * The run's new bugs that got no thread: in the summary, or unposted, and held by no open bug
 * thread of the bot by any of their fingerprints, since a write with no answer may still have
 * stored its thread.
 */
export function countUnthreadedBugs(
	plan: PublishPlan,
	threads: readonly BotThread[]
): number {
	const held = getHeldFingerprints(threads)
	return plan.threads.filter(
		thread =>
			thread.kind === 'bug' &&
			!THREAD_PLACES.some(place => place === thread.place) &&
			!isHeld(thread.finding, held)
	).length
}

/**
 * Open bug threads after the run: the bot's open ones (`isOpenBug`), plus each new bug of this run
 * that no open thread holds by fingerprint, wherever it went. Read after posting, `threads` holds
 * what this run and any run alongside it posted; read before, every new bug is counted from the
 * plan.
 */
export function countOpenBugs(
	plan: PublishPlan,
	threads: readonly BotThread[]
): number {
	const held = getHeldFingerprints(threads)
	const open = threads.filter(isOpenBug).length
	return (
		open +
		plan.threads.filter(
			thread => thread.kind === 'bug' && !isHeld(thread.finding, held)
		).length
	)
}

/** A line thread moved into the summary after GitHub refused the review's inline comments. */
export function toSummaryPlace(thread: PlannedThread): PlannedThread {
	return thread.place === 'line' ? { ...thread, place: 'summary' } : thread
}
