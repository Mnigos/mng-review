import type { KeptFinding, ReplyAction } from '@mng-review/domain'
import type { ReviewState } from '../../../platform/github-api.schema'
import type { Verdict } from '../presentation/summary-comment.formatter'
import type {
	FindingMarker,
	SummaryMarker,
	ThreadKind,
} from './publish-marker.schema'
import type { ReviewDecision, ReviewEvidence } from './review-event.helper'
import type {
	DecidedThreadReply,
	ThreadReplyDecision,
} from './thread-reply.schema'

/** One of the bot's review threads, found by its author and its marker. */
export interface BotThread {
	/** The GraphQL node id, used to resolve it. */
	readonly id: string
	/** Resolved on GitHub, or closed by the bot's own `resolved` or `accepted` reply. */
	readonly resolved: boolean
	/** Closed by the bot's reply while GitHub still shows the thread open. */
	readonly closedByBot: boolean
	/** A comment on the whole file, not on a line. */
	readonly onFile: boolean
	readonly path: string
	/** The line at the head; unset when the line left the diff or the thread is on the file. */
	readonly line: number | undefined
	/** The line at `commit`. */
	readonly originalLine: number | undefined
	/** The commit the thread was posted on. */
	readonly commit: string | undefined
	readonly marker: FindingMarker
	/** Comments after the bot's first one. */
	readonly replies: number
	/** The `databaseId` of the thread's latest comment. */
	readonly latestCommentId: number | undefined
	/** Who wrote the latest comment, `type` as GraphQL's `__typename`. */
	readonly latestAuthor: ThreadAuthor | undefined
	/** The latest comment ends with a marker of the bot's form; such a comment is never a reply. */
	readonly latestMarked: boolean
	/** A digest of the latest comment's text (`toBodyDigest`), so an edit after a decision shows. */
	readonly latestDigest: string | undefined
	/**
	 * The head the bot's `resolved` or `accepted` reply names when that reply is the latest comment:
	 * the baseline for whether the finding's code changed since the thread was closed.
	 */
	readonly closedAt: string | undefined
	/**
	 * An owned bot's unedited `needs-owner` answer is among the latest comments the read brings
	 * (`RECENT_COMMENTS`); `ThreadReplyService.getSentToOwner` reads longer threads whole.
	 */
	readonly sentToOwner: boolean
	/**
	 * The token app's newest answer in the thread is unsettled (`isUnsettled`); unset when the read's
	 * windows do not show that answer, so only the whole thread tells.
	 */
	readonly unsettled?: boolean
}

/** A comment's author as the thread read names it. */
export interface ThreadAuthor {
	readonly type: string
	readonly login: string
}

/** A kept finding the run publishes, with the kind of thread it gets. */
export interface PublishedFinding {
	readonly finding: KeptFinding
	readonly kind: ThreadKind
}

/**
 * Where a new finding goes: an inline thread on its line, a comment on its file when the line is
 * outside the diff, or the summary when the file is not in the diff at all or GitHub refused both.
 * `pull_request`: a finding only metadata agents reported is about the pull request itself (its
 * title, description or size), not a line, so it stays in the summary whatever path it names.
 * `unposted`: a write failed in a way that leaves unknown whether GitHub stored it, so nothing
 * more is tried; the next run finds the thread or posts it.
 */
export type ThreadPlace =
	| 'line'
	| 'file'
	| 'summary'
	| 'pull_request'
	| 'unposted'

/** A finding the run publishes and where. */
export interface PlannedThread extends PublishedFinding {
	readonly place: ThreadPlace
}

/** What one run posts: new threads, the findings already open or resolved, and nits for the summary. */
export interface PublishPlan {
	readonly threads: readonly PlannedThread[]
	/** Findings an open thread of the bot already covers. */
	readonly repeated: readonly PublishedFinding[]
	/** Findings found again under threads resolved without a code change since; not blocking. */
	readonly dismissed: readonly PublishedFinding[]
	readonly summaryNits: readonly KeptFinding[]
}

/** The head-side lines of the pull request's diff that can carry an inline comment, by path. */
export type CommentableLines = ReadonlyMap<string, ReadonlySet<number>>

/** A thread the bot resolved because the validator no longer finds its finding at the head, with why. */
export interface ResolvedThread {
	readonly thread: BotThread
	readonly reason: string
}

/**
 * A thread the re-check proposes to resolve, named by its node id and its marker's fingerprint;
 * publishing applies it only when its own fresh read still shows that thread open and unanswered.
 */
export interface RecheckProposal {
	readonly threadId: string
	readonly fingerprint: string
	/** The validator's reason, shown escaped in the reply. */
	readonly reason: string
}

/** A summary as read, a review's body or an old sticky comment: who wrote it and its marker. */
export interface SummaryComment {
	readonly id: number
	/** The GraphQL node id, which hiding it takes. */
	readonly nodeId: string
	readonly marker: SummaryMarker
	readonly body: string
	/** Written by the identity the token posts as; only such a summary is ever edited. */
	readonly mine: boolean
}

/** A review of an owned identity whose body ends with a summary marker. */
export interface SummaryReview extends SummaryComment {
	readonly state: ReviewState
	/** The commit the review is on, when the read asked for it. */
	readonly commit: string | undefined
	/** Hidden as outdated or otherwise; its marker still counts. */
	readonly minimized: boolean
}

/**
 * What the cleanup after a write left: an earlier review or an old sticky comment of an owned
 * identity hidden (`minimized`), an old sticky comment deleted after GitHub refused to hide it,
 * `kept` when one stayed visible, `none` when nothing was left to hide.
 */
export type SummaryCleanup = 'none' | 'minimized' | 'deleted' | 'kept'

/** What the dismissals after a write did: reviews dismissed, and dismissals GitHub refused or never answered. */
export interface DismissalOutcome {
	readonly dismissed: number
	readonly failed: number
}

/** A summary built from the summary read just before it is written: its text, marker and state. */
export interface RenderedSummary {
	readonly body: string
	readonly marker: SummaryMarker
	/** What the run judged, for its review's state (`getReviewDecision`); unset, like offline, judged nothing. */
	readonly evidence?: ReviewEvidence
	/** The verdict, open bugs and whether a full review finished, as this render judged them. */
	readonly standing?: SummaryStanding
}

/** What a render judged the pull request's standing to be. */
export interface SummaryStanding {
	readonly verdict: Verdict
	readonly openBugs: number
	readonly finished: boolean
}

/** An author's reply the bot answered in this run, with its decision. */
export interface AppliedReply {
	readonly thread: BotThread
	readonly decision: ThreadReplyDecision
	/** The `databaseId` of the author's comment the answer names. */
	readonly commentId: number
	/** The digest the decision was made on; unset means the thread's latest. */
	readonly digest?: string
	/** The reply versions the collection saw unnamed; unset names every unnamed reply. */
	readonly named?: DecidedThreadReply['named']
	/**
	 * The thread could not be reopened after the answer, so a resolution GitHub shows may predate it
	 * and clears no wait (`toFreshResolvers`).
	 */
	readonly unsettled?: true
}

/**
 * What became of the `needs-owner` label: added while a thread waits, removed when the last one is
 * cleared, `failed` when GitHub refused (the next run tries again while a thread waits), `none`.
 */
export type LabelOutcome = 'added' | 'removed' | 'failed' | 'none'

/** Answers a run wrote, by action. */
export type AnswerCounts = Partial<Record<ReplyAction, number>>

/** A rendered summary and the state `getReviewDecision` picked for it. */
export interface DecidedSummary {
	readonly rendered: RenderedSummary
	readonly decision: ReviewDecision
}
