import type { ReviewReport } from '@mng-review/engine'
import {
	type BotIdentity,
	isIdentity,
	isOwnedBot,
	toBotIdentity,
} from '../../../platform/bot-identity.helper'
import type {
	PullRequestComment,
	ReviewThread,
} from '../../../platform/github-api.schema'
import type { GitHubApiError } from '../../../platform/github.errors'
import type { Verdict } from '../presentation/summary-comment.formatter'
import { parseFindingMarker, parseReplyMarker } from './publish-marker.parser'
import type { BotThread } from './publish.types'

/** The status GitHub answers when it refuses a comment's place, such as a line outside the diff. */
const UNPROCESSABLE_STATUS = 422

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

/**
 * The bot's thread with its marker, or `undefined` for anyone else's thread, an edited one or an
 * unmarked one. A thread whose latest comment is a reply of any owned identity that the finding no
 * longer holds counts as resolved: the bot's tokens cannot resolve threads (GitHub asks for
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
	const [latest] = thread.latest?.nodes ?? []
	const closedByBot =
		thread.comments.totalCount > 1 &&
		latest !== undefined &&
		isBotComment(latest, owned) &&
		parseReplyMarker(latest.body)?.action === 'resolved'
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
	}
}

/** True for a refusal of the comment's place, the only failure after which another place is tried. */
export function isRefused(error: GitHubApiError): boolean {
	return error.status === UNPROCESSABLE_STATUS
}

/**
 * `incomplete` when nothing blocks but the run did not finish: an endpoint failure, the token
 * budget, or a finder that failed or stopped, so a run that reviewed nothing never reads as ready.
 */
export function getVerdict(report: ReviewReport, openBugs: number): Verdict {
	if (openBugs > 0) return 'needs fixes'
	return isFinished(report) ? 'ready' : 'incomplete'
}

/** True when every finder answered: no endpoint failure, no budget stop, no agent that failed or stopped. */
export function isFinished(report: ReviewReport): boolean {
	return (
		!report.endpointError &&
		!report.incomplete &&
		report.agents.every(agent => agent.status === 'ok')
	)
}
