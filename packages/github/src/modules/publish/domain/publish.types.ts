import type { KeptFinding } from '@mng-review/domain'
import type {
	FindingMarker,
	SummaryMarker,
	ThreadKind,
} from './publish-marker.schema'

/** One of the bot's review threads, found by its author and its marker. */
export interface BotThread {
	/** The GraphQL node id, used to resolve it. */
	readonly id: string
	/** Resolved on GitHub, or closed by the bot's own reply that the finding no longer holds. */
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

/** A sticky summary as read: who wrote it and the marker it ends with. */
export interface SummaryComment {
	readonly id: number
	/** The GraphQL node id, which hiding it takes. */
	readonly nodeId: string
	readonly marker: SummaryMarker
	readonly body: string
	/** Written by the identity the token posts as; only such a summary is ever edited. */
	readonly mine: boolean
}

/**
 * What the cleanup after a write left: another owned identity's summary hidden (`minimized`) or
 * deleted; `kept` when one could not be hidden or deleted, or a duplicate summary of the current
 * identity could not be deleted. A deleted duplicate counts as `none`.
 */
export type SummaryCleanup = 'none' | 'minimized' | 'deleted' | 'kept'

/** A summary built from the summary read just before it is written: its text and marker. */
export interface RenderedSummary {
	readonly body: string
	readonly marker: SummaryMarker
}
