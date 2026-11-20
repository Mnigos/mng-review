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
 * the last run that finished. An unfinished run keeps the previous head and unthreaded bugs. Every
 * other field of the previous marker is carried as it was.
 */
export function toNextSummaryMarker(
	previous: SummaryMarker | undefined,
	update: MarkerUpdate
): SummaryMarker {
	const {
		head: previousHead,
		unthreadedBugs: previousBugs,
		...carried
	} = previous ?? { v: MARKER_VERSION, runs: 0 }
	const head = update.finished ? update.head : previousHead
	const unthreadedBugs = update.finished
		? update.unthreadedBugs
		: (previousBugs ?? 0)
	return {
		...carried,
		v: MARKER_VERSION,
		runs: carried.runs + 1,
		finished: update.finished,
		...(head === undefined ? {} : { head }),
		...(unthreadedBugs > 0 ? { unthreadedBugs } : {}),
	}
}
