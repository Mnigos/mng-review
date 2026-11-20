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

/**
 * The summary with one more manual run counted: an existing summary keeps its text and every other
 * marker field; with none, a status summary that names the handle the command mentioned in a code
 * span, so it notifies no one.
 */
export function toReservedSummary(
	current: SummaryComment | undefined,
	handle: string,
	links: BlobLinks
): RenderedSummary {
	if (current) {
		const marker = {
			...current.marker,
			manualRuns: (current.marker.manualRuns ?? 0) + 1,
		}
		return { body: toSummaryWithMarker(current.body, marker), marker }
	}
	const marker = { ...NO_RUN_MARKER, manualRuns: 1 }
	return {
		body: formatStatusComment(
			`A command to @${handle} started a manual review on this pull request.`,
			marker,
			links
		),
		marker,
	}
}
