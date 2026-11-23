import type {
	PullRequestComment,
	PullRequestReview,
} from '../../../platform/github-api.schema'
import type { InlineComment } from '../../../platform/github-review.service'
import type {
	RenderedSummary,
	SummaryCleanup,
	SummaryComment,
	SummaryReview,
} from '../domain/publish.types'
import type { PublishTarget } from './publish.service.types'

/**
 * What a write left: the summary written, whether it is a review this write created, whether the
 * draft's inline comments went into it, and what became of earlier reviews and sticky comments.
 */
export interface WrittenSummary extends RenderedSummary {
	readonly cleanup: SummaryCleanup
	readonly created: boolean
	/** `false` when GitHub refused the inline comments and the body lists their findings instead. */
	readonly inline: boolean
	/** Change requests of owned identities this write dismissed as stale. */
	readonly dismissed: number
}

/** A manual run to count before the endpoint is used. */
export interface ManualRunInput extends PublishTarget {
	/** `commands.max_runs` at the reviewed base. */
	readonly maxRuns: number
	/** The handle commands mention; a status review the reservation creates names it in a code span. */
	readonly handle: string
}

/**
 * Builds the summary over the one read just before the write; `undefined` when there is none.
 * `inline` is `false` when GitHub refused the inline comments, whose findings the body then lists.
 */
export type SummaryRender = (
	current: SummaryComment | undefined,
	inline: boolean
) => RenderedSummary

/** One run's review: the summary, the run's new inline comments and whether it posted threads. */
export interface SummaryDraft {
	/** The commit the review and its comments are on. */
	readonly head: string
	readonly render: SummaryRender
	readonly comments?: readonly InlineComment[]
	/** The run posted threads of its own, inline or on a file, so the summary is a new review. */
	readonly fresh?: boolean
}

/** The pull request's reviews and conversation comments, and the summaries among them. */
export interface SummaryRead {
	readonly raw: readonly PullRequestReview[]
	readonly comments: readonly PullRequestComment[]
	readonly reviews: readonly SummaryReview[]
	readonly summaries: readonly SummaryComment[]
}

/** A review this write posted: its id, the summary it holds and whether its comments went in. */
export interface PostedReview {
	readonly id: number
	readonly rendered: RenderedSummary
	readonly inline: boolean
}
