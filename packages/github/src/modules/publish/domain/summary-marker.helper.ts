import type { SummaryMarker } from './publish-marker.schema'
import { MARKER_VERSION } from './publish.constants'

/** What one publish run tells the next summary marker. */
export interface MarkerUpdate {
	readonly head: string
	/** Every finder answered. */
	readonly finished: boolean
	/**
	 * The run does not stand for a full review of `head`: a command named one agent, or the pull
	 * request moved to another head while it reviewed.
	 */
	readonly partial: boolean
	/** This run's bugs that got no thread. */
	readonly unthreadedBugs: number
}

/** A run as the marker judges it: its head, and whether it stands for a full review. */
export type MarkedRun = Pick<MarkerUpdate, 'head' | 'partial'>

/**
 * The summary marker after a run: one more run, and the head, finished flag and unthreaded bugs of
 * the last full review. An unfinished run keeps the previous head and unthreaded bugs; a partial
 * run keeps the previous finished flag as well, so it never stands for a full review. Every other
 * field of the previous marker, such as the manual runs, is carried as it was.
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
	const reviewed = update.finished && !update.partial
	const finished = update.partial
		? (carried.finished ?? false)
		: update.finished
	const head = reviewed ? update.head : previousHead
	const unthreadedBugs = reviewed ? update.unthreadedBugs : (previousBugs ?? 0)
	return {
		...carried,
		v: MARKER_VERSION,
		runs: carried.runs + 1,
		finished,
		...(head === undefined ? {} : { head }),
		...(unthreadedBugs > 0 ? { unthreadedBugs } : {}),
	}
}

/**
 * The bugs without a thread a partial run still counts: those the last full review left on the
 * same head, read from the marker the run builds on or wrote, which a partial run keeps as it was.
 */
export function getCarriedBugs(
	marker: Pick<SummaryMarker, 'head' | 'unthreadedBugs'> | undefined,
	run: MarkedRun
): number {
	if (!run.partial || marker?.head !== run.head) return 0
	return marker.unthreadedBugs ?? 0
}
