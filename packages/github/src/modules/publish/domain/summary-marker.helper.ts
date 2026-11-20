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

/** True when the run replaces the last full review in the marker: a full run that finished. */
function isReplacing(
	update: Pick<MarkerUpdate, 'finished' | 'partial'>
): boolean {
	return update.finished && !update.partial
}

/**
 * The summary marker after a run: one more run, and the head, finished flag and unthreaded bugs of
 * the last full review. A run that does not replace it (a partial run, or a full run that did not
 * finish) keeps the previous head; a partial run keeps the previous finished flag as well, so it
 * never stands for a full review. Such a run adds its own unthreaded bugs to those already on the
 * same head, so they keep blocking until the next full review replaces the count; a bug it found
 * again is counted twice until then. Every other field of the previous marker, such as the manual
 * runs, is carried as it was.
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
	const reviewed = isReplacing(update)
	const finished = update.partial
		? (carried.finished ?? false)
		: update.finished
	const head = reviewed ? update.head : previousHead
	const added = previousHead === update.head ? update.unthreadedBugs : 0
	const unthreadedBugs = reviewed
		? update.unthreadedBugs
		: (previousBugs ?? 0) + added
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
 * The bugs without a thread a run that does not replace the last full review still counts: those
 * the marker held for the run's head before the run. `marker` is the one the run wrote with
 * `toNextSummaryMarker`, so the run's own unthreaded bugs, which it counts itself, come off.
 */
export function getCarriedBugs(
	marker: Pick<SummaryMarker, 'head' | 'unthreadedBugs'> | undefined,
	update: MarkerUpdate
): number {
	if (isReplacing(update) || marker?.head !== update.head) return 0
	return Math.max(0, (marker.unthreadedBugs ?? 0) - update.unthreadedBugs)
}
