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

/** A run's owner waits before the write: every one it would store, those it holds, the cleared. */
export interface StoredWaitInput {
	readonly all: readonly string[]
	/** Threads a failed whole-thread read left unknown, which wait for this run only. */
	readonly held: readonly string[]
	readonly cleared: ReadonlySet<string>
}

/** The marker's waiting update and the threads the run holds for itself only. */
export interface StoredWaits {
	readonly update: WaitingUpdate
	readonly held: readonly string[]
}

/**
 * What a write stores of the owner's waits: every one without those an owner cleared. When a list
 * read of the run, the write's own included, left a node out, it clears none, so the marker keeps
 * every wait it had and `syncLabel` keeps the label (ADR 0012).
 */
export function toStoredWaits(
	input: StoredWaitInput,
	incomplete: boolean
): StoredWaits {
	const cleared = incomplete ? new Set<string>() : input.cleared
	return {
		update: { added: input.all.filter(id => !cleared.has(id)), cleared },
		held: input.held.filter(id => !cleared.has(id)),
	}
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
 * and gain this run's, whatever the head. A marker an incomplete write left (`isIncompleteMarker`)
 * stays one until such a full run replaces it. Every other field of the previous marker, such as
 * the manual runs, is carried as it was.
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
	// The hold an incomplete write left stays until a full run that finished replaces the marker.
	const failed =
		update.partial || (!reviewed && isIncompleteMarker(previous))
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

/**
 * The marker a run whose list reads left a node out writes: unfinished and failed, since that node
 * may be a newer summary this marker should have built on, or something its verdict missed. No run
 * and no sweep reads it as `ready`, writes `success` or lifts a change request until a full run
 * that finished with complete reads replaces it (ADR 0012). It keeps the run's head, unthreaded
 * bugs and waits.
 */
export function toIncompleteMarker(marker: SummaryMarker): SummaryMarker {
	return { ...marker, finished: false, failed: true }
}

/** True for a marker `toIncompleteMarker` wrote, or one that carried its hold. */
export function isIncompleteMarker(
	marker: Pick<SummaryMarker, 'finished' | 'failed'> | undefined
): boolean {
	return marker?.failed === true && marker.finished !== true
}

/** The flags a publish result carries for the holds on its run. */
export interface HoldFlags {
	/** A list read of the run left a null node out. */
	readonly incomplete?: true
	/** The marker the run wrote keeps the hold an incomplete write left (`isIncompleteMarker`). */
	readonly held?: true
}

/** The hold flags of a run whose list reads were `incomplete` or not and that wrote `marker`. */
export function toHoldFlags(
	incomplete: boolean,
	marker: SummaryMarker
): HoldFlags {
	return {
		...(incomplete ? { incomplete: true } : {}),
		...(isIncompleteMarker(marker) ? { held: true } : {}),
	}
}

/**
 * True when `commands.max_runs` stops a manual run: the marker counts that many manual runs. A full
 * review (no `agent`) passes while the marker is one an incomplete write left
 * (`isIncompleteMarker`), since only such a run can replace it. The reservation refuses only when
 * its own summary read drops a node, so while the null node is in the review threads an owner can
 * repeat `review` past `commands.max_runs`, each run staying incomplete.
 */
export function isManualRunCapped(
	marker: Pick<SummaryMarker, 'manualRuns' | 'finished' | 'failed'> | undefined,
	maxRuns: number,
	agent: string | undefined
): boolean {
	if (agent === undefined && isIncompleteMarker(marker)) return false
	return (marker?.manualRuns ?? 0) >= maxRuns
}

/**
 * `marker` with its run and manual run counts raised to the most any listed summary marker holds,
 * so a marker built on an older summary, which an incomplete read can leave newest, never counts
 * fewer runs than one already written.
 */
export function toCountedMarker(
	marker: SummaryMarker,
	listed: readonly SummaryMarker[]
): SummaryMarker {
	const runs = Math.max(marker.runs, ...listed.map(entry => entry.runs))
	const manualRuns = Math.max(
		marker.manualRuns ?? 0,
		...listed.map(entry => entry.manualRuns ?? 0)
	)
	return { ...marker, runs, ...(manualRuns > 0 ? { manualRuns } : {}) }
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
 * The marker as one run judges it: its waiting threads plus those the run holds for itself only,
 * such as the longer threads a failed whole-thread read could not check. Never written.
 */
export function toJudgedMarker(
	marker: SummaryMarker,
	held: readonly string[]
): SummaryMarker {
	if (held.length === 0) return marker
	return {
		...marker,
		needsOwner: [...new Set([...(marker.needsOwner ?? []), ...held])],
	}
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
