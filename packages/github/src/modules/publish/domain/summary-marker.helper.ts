import type { AnswerEntry } from '@mng-review/domain'
import { Schema } from 'effect'
import type { RatingBlock } from '../../risk/domain/risk.types'
import {
	summaryMarkerSchema,
	type SummaryMarker,
} from './publish-marker.schema'
import { MARKER_VERSION } from './publish.constants'
import { SummaryMarkerError } from './publish.errors'

/** What one publish run tells the next summary marker. */
export interface MarkerUpdate {
	readonly head: string
	/** Every finder answered. */
	readonly finished: boolean
	/** A planned run or unit failed or never reported (`hasFailedRuns`). */
	readonly failed?: boolean
	/**
	 * The run does not stand for a full review of `head`: a command named one agent, or the pull
	 * request moved to another head while it reviewed.
	 */
	readonly partial: boolean
	/** This run's bugs that got no thread. */
	readonly unthreadedBugs: number
	/** Threads this run sent to the owner, and waiting ones an owner cleared. */
	readonly waiting?: WaitingUpdate
}

/** How a run changes the threads that wait for the owner. */
export interface WaitingUpdate {
	readonly added: readonly string[]
	readonly cleared: ReadonlySet<string>
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
 * finish) keeps the previous head; a partial run keeps the previous finished and failed flags as
 * well, so it never stands for a full review. Such a run adds its own unthreaded bugs to those
 * already on the same head, so they keep blocking until the next full review replaces the count; a
 * bug it found again is counted twice until then. The threads waiting for the owner lose those an owner cleared
 * and gain this run's, whatever the head. Every other field of the previous marker, such as the
 * manual runs, is carried as it was.
 */
export function toNextSummaryMarker(
	previous: SummaryMarker | undefined,
	update: MarkerUpdate
): SummaryMarker {
	const {
		head: previousHead,
		unthreadedBugs: previousBugs,
		needsOwner: previousWaiting,
		failed: previousFailed,
		...carried
	} = previous ?? { v: MARKER_VERSION, runs: 0 }
	const needsOwner = toNextWaiting(previousWaiting, update.waiting)
	const reviewed = isReplacing(update)
	const finished = update.partial
		? (carried.finished ?? false)
		: update.finished
	// Like the finished flag, a partial run keeps the last full run's; only a finished run needs it.
	const failed = update.partial
		? previousFailed
		: update.finished && update.failed === true
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
		...(failed === true ? { failed } : {}),
		...(head === undefined ? {} : { head }),
		...(unthreadedBugs > 0 ? { unthreadedBugs } : {}),
		...(needsOwner.length > 0 ? { needsOwner } : {}),
	}
}

/** The waiting thread ids without those an owner cleared, plus this run's, each once. */
function toNextWaiting(
	previous: readonly string[] | undefined,
	update: WaitingUpdate | undefined
): string[] {
	return [
		...new Set([
			...(previous ?? []).filter(id => !update?.cleared.has(id)),
			...(update?.added ?? []),
		]),
	]
}

/**
 * The summary marker after a reply-only run, which reviewed nothing: the run count, head, finished
 * flag and unthreaded bugs stay; only the threads waiting for the owner change.
 */
export function toRepliedMarker(
	previous: SummaryMarker | undefined,
	waiting: WaitingUpdate
): SummaryMarker {
	const { needsOwner: previousWaiting, ...carried } = previous ?? {
		v: MARKER_VERSION,
		runs: 0,
	}
	const needsOwner = toNextWaiting(previousWaiting, waiting)
	return { ...carried, ...(needsOwner.length > 0 ? { needsOwner } : {}) }
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

/** What a review's marker records besides the run: the published rating and the commands answered. */
export interface MarkerAnswers {
	readonly rating?: RatingBlock
	readonly answers?: readonly AnswerEntry[]
}

/**
 * The marker with the level a rated block published, which makes the pull request's app history,
 * and the entries of the commands this review answers after those the marker already carried, so
 * an edited summary never drops an earlier answer.
 */
export function toAnsweredMarker(
	marker: SummaryMarker,
	input: MarkerAnswers
): SummaryMarker {
	const answers = [...(marker.answers ?? []), ...(input.answers ?? [])]
	return {
		...marker,
		...(input.rating?.status === 'rated' ? { risk: input.rating.level } : {}),
		...(answers.length > 0 ? { answers } : {}),
	}
}

/**
 * The failure of a summary write whose marker no read decodes, such as one past
 * `MAX_ANSWER_ENTRIES` answer entries; `undefined` when it decodes. Such a marker would lose the
 * pull request's runs and answers for good, so the write fails instead.
 */
export function getMarkerError(
	marker: SummaryMarker
): SummaryMarkerError | undefined {
	const answers = marker.answers?.length ?? 0
	return Schema.is(summaryMarkerSchema)(marker)
		? undefined
		: new SummaryMarkerError({ answers })
}

/**
 * The marker a summary read keeps: a summary the current identity did not write loses its answer
 * entries, so carrying it into the current app's summary never makes them the app's answers.
 */
export function toReadMarker(
	marker: SummaryMarker,
	mine: boolean
): SummaryMarker {
	if (mine) return marker
	const { answers: _answers, ...rest } = marker
	return rest
}
