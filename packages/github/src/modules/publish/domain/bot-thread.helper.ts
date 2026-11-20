import { createHash } from 'node:crypto'
import { commitShaSchema } from '@mng-review/domain'
import type { ReviewReport } from '@mng-review/engine'
import { Schema } from 'effect'
import {
	type BotIdentity,
	isIdentity,
	isOwnedBot,
	toBotIdentity,
} from '../../../platform/bot-identity.helper'
import { RECENT_COMMENTS } from '../../../platform/github-api.constants'
import type {
	PullRequestComment,
	ReviewThread,
	ThreadComment,
} from '../../../platform/github-api.schema'
import type { GitHubApiError } from '../../../platform/github.errors'
import type { Verdict } from '../presentation/summary-comment.formatter'
import {
	hasBotMarker,
	parseFindingMarker,
	parseReplyMarker,
} from './publish-marker.parser'
import type { SummaryMarker } from './publish-marker.schema'
import type { BotThread } from './publish.types'
import type { MarkedRun } from './summary-marker.helper'

/** The status GitHub answers when it refuses a comment's place, such as a line outside the diff. */
const UNPROCESSABLE_STATUS = 422
/** The bot's reply actions that close a thread for its counts. */
const CLOSING_ACTIONS: ReadonlySet<string> = new Set(['resolved', 'accepted'])
const isCommitSha = Schema.is(commitShaSchema)

/** A digest of a comment's whole text: two reads of one comment differ in it once someone edited it. */
export function toBodyDigest(body: string): string {
	return createHash('sha256').update(body).digest('hex')
}

/**
 * True when an owned bot wrote the comment and nobody but that same bot edited it since. An edit
 * by another bot, even an owned one, ends the ownership.
 */
export function isBotComment(
	comment: Pick<PullRequestComment, 'author' | 'editor'>,
	owned: readonly BotIdentity[]
): boolean {
	const { author, editor } = comment
	if (!(author && isOwnedBot(author, owned))) return false
	return editor === null || isIdentity(editor, toBotIdentity(author.login))
}

/** True when an owned bot's unedited comment among `comments` is a `needs-owner` answer. */
export function hasOwnerAnswer(
	comments: readonly ThreadComment[],
	owned: readonly BotIdentity[]
): boolean {
	return comments.some(
		comment =>
			isBotComment(comment, owned) &&
			parseReplyMarker(comment.body)?.action === 'needs-owner'
	)
}

/**
 * Ids of the review threads with an owned, unedited `needs-owner` answer among the latest comments
 * the read brought, whoever owns the first comment now: an edit to it ends the bot's ownership of
 * the thread, not of its answers.
 */
export function getOwnerAnswered(
	threads: readonly ReviewThread[],
	owned: readonly BotIdentity[]
): string[] {
	return threads
		.filter(thread => hasOwnerAnswer(thread.latest?.nodes ?? [], owned))
		.map(thread => thread.id)
}

/**
 * The threads whose `needs-owner` answer may sit before the latest comments the read brought: an
 * owned bot wrote the first comment, edited or not, as the bot answers only there; the thread has
 * more comments than the read brought and no answer among them; and it is not the bot's own nit
 * thread, which it never answers in.
 */
export function getUnreadOwnerThreads(
	threads: readonly ReviewThread[],
	owned: readonly BotIdentity[]
): ReviewThread[] {
	return threads.filter(thread => {
		const [first] = thread.comments.nodes
		if (!first?.author || !isOwnedBot(first.author, owned)) return false
		if (toBotThread(thread, owned)?.marker.kind === 'nit') return false
		return (
			thread.comments.totalCount > RECENT_COMMENTS &&
			!hasOwnerAnswer(thread.latest?.nodes ?? [], owned)
		)
	})
}

/**
 * The head named by the thread's latest comment when that is an owned bot's `resolved` or `accepted`
 * reply, or `undefined`. An answer whose marker names no full SHA closes the thread all the same.
 */
function getClosingCommit(
	thread: Pick<ReviewThread, 'comments'>,
	latest: ThreadComment | undefined,
	owned: readonly BotIdentity[]
): string | undefined {
	if (
		thread.comments.totalCount <= 1 ||
		latest === undefined ||
		!isBotComment(latest, owned)
	)
		return undefined
	const marker = parseReplyMarker(latest.body)
	if (!(marker && CLOSING_ACTIONS.has(marker.action))) return undefined
	return marker.commit
}

/** What a thread keeps of its latest comment: id, author, whether it ends with a marker, its digest. */
function toLatestFields(
	comment: ThreadComment
): Pick<
	BotThread,
	'latestCommentId' | 'latestAuthor' | 'latestMarked' | 'latestDigest'
> {
	const { author } = comment
	return {
		latestCommentId: comment.databaseId ?? undefined,
		latestAuthor: author
			? { type: author.__typename, login: author.login }
			: undefined,
		latestMarked: hasBotMarker(comment.body),
		latestDigest: toBodyDigest(comment.body),
	}
}

/**
 * The bot's thread with its marker, or `undefined` for anyone else's thread, an edited one or an
 * unmarked one. A thread whose latest comment is a `resolved` or `accepted` reply of any owned
 * identity counts as resolved: the bot's tokens cannot resolve threads (GitHub asks for
 * `contents: write`).
 */
export function toBotThread(
	thread: ReviewThread,
	owned: readonly BotIdentity[]
): BotThread | undefined {
	const [first] = thread.comments.nodes
	if (!first || !isBotComment(first, owned)) return undefined
	const marker = parseFindingMarker(first.body)
	if (!marker) return undefined
	const onFile = thread.subjectType === 'FILE'
	const recent = thread.latest?.nodes ?? []
	const latest = recent.at(-1)
	const closing = getClosingCommit(thread, latest, owned)
	const closedByBot = closing !== undefined
	return {
		id: thread.id,
		resolved: thread.isResolved || closedByBot,
		closedByBot: closedByBot && !thread.isResolved,
		onFile,
		path: thread.path,
		line: onFile ? undefined : (thread.line ?? undefined),
		originalLine: onFile ? marker.line : (thread.originalLine ?? marker.line),
		commit: first.originalCommit?.oid,
		marker,
		replies: Math.max(0, thread.comments.totalCount - 1),
		...toLatestFields(latest ?? first),
		closedAt:
			closing !== undefined && isCommitSha(closing) ? closing : undefined,
		sentToOwner: hasOwnerAnswer(recent, owned),
	}
}

/** True for a refusal of the comment's place, the only failure after which another place is tried. */
export function isRefused(error: GitHubApiError): boolean {
	return error.status === UNPROCESSABLE_STATUS
}

/**
 * `needs owner` while a thread waits for the owner, whatever else is open; `needs fixes` while bug
 * threads are open. `incomplete` when nothing blocks but the run did not finish: an endpoint failure, the token
 * budget, or a finder that failed or stopped, so a run that reviewed nothing never reads as ready.
 */
export function getVerdict(
	report: ReviewReport,
	openBugs: number,
	finished: boolean = isFinished(report),
	waiting = 0
): Verdict {
	if (waiting > 0) return 'needs owner'
	if (openBugs > 0) return 'needs fixes'
	return finished ? 'ready' : 'incomplete'
}

/** True when every finder answered: no endpoint failure, no budget stop, no agent that failed or stopped. */
export function isFinished(report: ReviewReport): boolean {
	return (
		!report.endpointError &&
		!report.incomplete &&
		report.agents.every(agent => agent.status === 'ok')
	)
}

/**
 * True when a full review finished on the run's head: this run when it stands for one, or for a
 * partial run the last full review when it was on the same head. `marker` is the summary marker
 * the run builds on or wrote; a partial run keeps its head and finished flag as they were.
 */
export function isFullReview(
	report: ReviewReport,
	marker: Pick<SummaryMarker, 'finished' | 'head'> | undefined,
	run: MarkedRun
): boolean {
	if (!run.partial) return isFinished(report)
	return marker?.finished === true && marker.head === run.head
}
