import type { KeptFinding } from '@mng-review/domain'
import type { FindingMarker, ThreadKind } from './publish-marker.schema'

/** One of the bot's review threads, found by its author and its marker. */
export interface BotThread {
	/** The GraphQL node id, used to resolve it. */
	readonly id: string
	readonly resolved: boolean
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
 * `unposted`: a write failed in a way that leaves unknown whether GitHub stored it, so nothing
 * more is tried; the next run finds the thread or posts it.
 */
export type ThreadPlace = 'line' | 'file' | 'summary' | 'unposted'

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
