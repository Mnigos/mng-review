import { toCodeSpan } from '../../../utils/markdown.util'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import { MARKER_VERSION } from '../domain/publish.constants'
import type { RenderedSummary, SummaryComment } from '../domain/publish.types'
import {
	formatStatusComment,
	toSummaryWithMarker,
	toUnfinishedSummary,
} from './summary-comment.formatter'
import type { BlobLinks } from './thread-comment.formatter'

/** The marker of a summary created before any run reviewed the pull request. */
const NO_RUN_MARKER = {
	v: MARKER_VERSION,
	runs: 0,
	finished: false,
} as const satisfies SummaryMarker

/**
 * The summary of a run that did not review: an existing summary keeps its text with the marker set
 * to unfinished, its run count and head kept; with none, a status summary.
 */
export function toOfflineSummary(
	current: SummaryComment | undefined,
	status: string,
	links: BlobLinks
): RenderedSummary {
	if (current)
		return {
			body: toUnfinishedSummary(current.body, current.marker),
			marker: { ...current.marker, finished: false },
		}
	return {
		body: formatStatusComment(status, NO_RUN_MARKER, links),
		marker: NO_RUN_MARKER,
	}
}

/** The summary with one more manual run counted: its text and every other marker field stay. */
export function toReservedSummary(current: SummaryComment): RenderedSummary {
	const marker = {
		...current.marker,
		manualRuns: (current.marker.manualRuns ?? 0) + 1,
	}
	return { body: toSummaryWithMarker(current.body, marker), marker }
}

/**
 * A status summary for a manual run when the current identity has no summary review to count it
 * in: one line naming the handle the command mentioned in a code span, so it notifies no one, over
 * the carried marker with one more manual run; with no marker to carry, unfinished.
 */
export function toReservedStatus(
	previous: SummaryMarker | undefined,
	handle: string,
	links: BlobLinks
): RenderedSummary {
	const marker = {
		...(previous ?? NO_RUN_MARKER),
		manualRuns: (previous?.manualRuns ?? 0) + 1,
	}
	return {
		body: formatStatusComment(
			`A command to @${handle} started a manual review on this pull request.`,
			marker,
			links
		),
		marker,
	}
}

/** The reason a stale change request is dismissed with: fixed text and the head, never model output. */
export function toClearedMessage(head: string): string {
	return `MNG Review no longer finds an open bug thread or a thread waiting for the owner at ${toCodeSpan(head)}.`
}

/** The reason a review this run just posted is dismissed with when a push landed right after it. */
export function toOutlivedReviewMessage(head: string): string {
	return `MNG Review has not reviewed ${toCodeSpan(head)}; this review was for an earlier commit.`
}

/**
 * The reason an approval on another commit is dismissed with; it claims nothing about `head`, which
 * the current identity may have approved.
 */
export function toStaleApprovalMessage(head: string): string {
	return `This approval was for another commit than ${toCodeSpan(head)}, so it no longer stands.`
}

/** The reason another owned identity's approval is dismissed with once the current identity's replaces it. */
export function toReplacedApprovalMessage(head: string): string {
	return `MNG Review's current identity reviewed ${toCodeSpan(head)}; its review replaces this approval.`
}
