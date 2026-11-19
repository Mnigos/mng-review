import type { SummaryMarker } from './publish-marker.schema'
import { MARKER_VERSION } from './publish.constants'

/** What one publish run tells the next summary marker. */
export interface MarkerUpdate {
	readonly head: string
	/** Every finder answered. */
	readonly finished: boolean
	/** A command named one agent, so the run is not a full review. */
	readonly agentOnly: boolean
	/** A `/mng-review` command started the run. */
	readonly manual: boolean
}

/**
 * The summary marker after a run: one more run, one more manual run when a command started it, and
 * the head and the finished flag of the last full review. A run that named one agent keeps the
 * previous head and flag, so it never stands for a full review.
 */
export function toNextSummaryMarker(
	previous: SummaryMarker | undefined,
	update: MarkerUpdate
): SummaryMarker {
	const finished = update.agentOnly
		? (previous?.finished ?? false)
		: update.finished
	const head = finished && !update.agentOnly ? update.head : previous?.head
	const manualRuns = (previous?.manualRuns ?? 0) + (update.manual ? 1 : 0)
	return {
		v: MARKER_VERSION,
		runs: (previous?.runs ?? 0) + 1,
		finished,
		...(head === undefined ? {} : { head }),
		...(manualRuns > 0 ? { manualRuns } : {}),
	}
}
