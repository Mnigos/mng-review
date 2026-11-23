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
