import type { ReviewReport } from '@mng-review/engine'
import type {
	PullRequestComment,
	ReviewThread,
} from '../../../platform/github-api.schema'
import type { GitHubApiError } from '../../../platform/github.errors'
import type { Verdict } from '../presentation/summary-comment.formatter'
import { parseFindingMarker } from './publish-marker.parser'
import { BOT_LOGIN } from './publish.constants'
import type { BotThread } from './publish.types'

/** The status GitHub answers when it refuses a comment's place, such as a line outside the diff. */
const UNPROCESSABLE_STATUS = 422

/** True when the bot wrote the comment and nobody else edited it since. */
export function isBotComment(
	comment: Pick<PullRequestComment, 'author' | 'editor'>
): boolean {
	return (
		comment.author?.__typename === 'Bot' &&
		comment.author.login === BOT_LOGIN &&
		(comment.editor === null || comment.editor.login === BOT_LOGIN)
	)
}

/** The bot's thread with its marker, or `undefined` for anyone else's thread, an edited one or an unmarked one. */
export function toBotThread(thread: ReviewThread): BotThread | undefined {
	const [first] = thread.comments.nodes
	if (!first || !isBotComment(first)) return undefined
	const marker = parseFindingMarker(first.body)
	if (!marker) return undefined
	const onFile = thread.subjectType === 'FILE'
	return {
		id: thread.id,
		resolved: thread.isResolved,
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
 * `incomplete` when the run did not finish and found nothing that blocks, so a run that reviewed
 * nothing never reads as ready.
 */
export function getVerdict(report: ReviewReport, openBugs: number): Verdict {
	if (openBugs > 0) return 'needs fixes'
	if (report.endpointError || report.incomplete) return 'incomplete'
	return 'ready'
}
