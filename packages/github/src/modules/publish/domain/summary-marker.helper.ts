import type { SummaryMarker } from './publish-marker.schema'
import { MARKER_VERSION } from './publish.constants'

/** What one publish run tells the next summary marker. */
export interface MarkerUpdate {
	readonly head: string
	/** Every finder answered. */
	readonly finished: boolean
	/** This run's bugs that got no thread. */
	readonly unthreadedBugs: number
}

/**
 * The summary marker after a run: one more run, and the head, finished flag and unthreaded bugs of
 * the last run that finished. An unfinished run keeps the previous head and unthreaded bugs.
 */
export function toNextSummaryMarker(
	previous: SummaryMarker | undefined,
	update: MarkerUpdate
): SummaryMarker {
	const head = update.finished ? update.head : previous?.head
	const unthreadedBugs = update.finished
		? update.unthreadedBugs
		: (previous?.unthreadedBugs ?? 0)
	return {
		v: MARKER_VERSION,
		runs: (previous?.runs ?? 0) + 1,
		finished: update.finished,
		...(head === undefined ? {} : { head }),
		...(unthreadedBugs > 0 ? { unthreadedBugs } : {}),
	}
}
