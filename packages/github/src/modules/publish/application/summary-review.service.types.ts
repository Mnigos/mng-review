import type {
	PullRequestComment,
	PullRequestReview,
} from '../../../platform/github-api.schema'
import type {
	InlineComment,
	ReviewEvent,
} from '../../../platform/github-review.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import type { SummaryMarkerError } from '../domain/publish.errors'
import type {
	DecidedSummary,
	DismissalOutcome,
	RenderedSummary,
	SummaryCleanup,
	SummaryComment,
	SummaryReview,
} from '../domain/publish.types'
import type { WrittenReview } from '../domain/summary-review.helper'
import type { PublishTarget } from './publish.service.types'

/**
 * What a write left: the summary written, whether it is a review this write created, whether the
 * draft's inline comments went into it, and what became of earlier reviews and sticky comments.
 */
export interface WrittenSummary extends RenderedSummary {
	/**
	 * The state the write posted or edited the review in, before any dismissal; `outlived` says
	 * whether it still stands.
	 */
	readonly event: ReviewEvent
	readonly cleanup: SummaryCleanup
	readonly created: boolean
	/** `false` when GitHub refused the inline comments and the body lists their findings instead. */
	readonly inline: boolean
	/** Owned change requests and approvals this write dismissed as stale, and those it could not. */
	readonly dismissal: DismissalOutcome
	/**
	 * The review the write left was dismissed after it: a push landed right after the write, so
	 * `event` no longer stands; unset is `false`.
	 */
	readonly outlived?: boolean
}

/** Why a summary write failed: GitHub refused a call, or the marker would not decode. */
export type SummaryWriteError = GitHubApiError | SummaryMarkerError

/** A manual run to count before the endpoint is used. */
export interface ManualRunInput extends PublishTarget {
	/** `commands.max_runs` at the reviewed base. */
	readonly maxRuns: number
	/** The handle commands mention; a status review the reservation creates names it in a code span. */
	readonly handle: string
}

/**
 * Builds the summary over the one read just before the write; `undefined` when there is none.
 * `inline` is `false` when the review carries no inline comments, whose findings the body then
 * lists: GitHub refused them, or the run is incomplete. `moved` is true when the write's own read
 * of the pull request's head, right before the review, did not show the reviewed head (or
 * failed). `incomplete` is true when a list read of the run, the write's own included, left a
 * null node out, so the summary clears no wait.
 */
export type SummaryRender = (
	current: SummaryComment | undefined,
	inline: boolean,
	moved: boolean,
	incomplete: boolean
) => RenderedSummary

/** One run's review: the summary, the run's new inline comments and whether it posted threads. */
export interface SummaryDraft {
	/**
	 * The commit the review and its comments are on: the head the run reviewed. The write reads the
	 * pull request's head again and judges approvals, change requests and edits against that.
	 */
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

/** A review this write posted or edited: its id, summary, decision, state and commit, and whether its comments went in. */
export interface PostedReview extends DecidedSummary {
	readonly id: number
	readonly review: WrittenReview
	readonly inline: boolean
}
