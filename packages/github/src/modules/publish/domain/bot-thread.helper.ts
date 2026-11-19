import type { ReviewReport } from '@mng-review/engine'
import type {
	PullRequestComment,
	ReviewThread,
} from '../../../platform/github-api.schema'
import type { GitHubApiError } from '../../../platform/github.errors'
import type { Verdict } from '../presentation/summary-comment.formatter'
import { parseFindingMarker, parseReplyMarker } from './publish-marker.parser'
import { BOT_LOGIN } from './publish.constants'
import type { BotThread } from './publish.types'

/** The status GitHub answers when it refuses a comment's place, such as a line outside the diff. */
const UNPROCESSABLE_STATUS = 422

/** True for the job token's bot: a `Bot`, so a user account named like it does not count. */
function isBot(actor: PullRequestComment['author']): boolean {
	return actor?.__typename === 'Bot' && actor.login === BOT_LOGIN
}

/** True when the bot wrote the comment and nobody else edited it since. */
export function isBotComment(
	comment: Pick<PullRequestComment, 'author' | 'editor'>
): boolean {
	return (
		isBot(comment.author) && (comment.editor === null || isBot(comment.editor))
	)
}

/**
 * The bot's thread with its marker, or `undefined` for anyone else's thread, an edited one or an
 * unmarked one. A thread whose latest comment is the bot's reply that the finding no longer holds
 * counts as resolved: the job token cannot resolve threads (GitHub asks for `contents: write`).
 */
export function toBotThread(thread: ReviewThread): BotThread | undefined {
	const [first] = thread.comments.nodes
	if (!first || !isBotComment(first)) return undefined
	const marker = parseFindingMarker(first.body)
	if (!marker) return undefined
	const onFile = thread.subjectType === 'FILE'
	const [latest] = thread.latest?.nodes ?? []
	const closedByBot =
		thread.comments.totalCount > 1 &&
		latest !== undefined &&
		isBotComment(latest) &&
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
