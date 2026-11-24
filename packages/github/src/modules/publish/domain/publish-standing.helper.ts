import type { ReviewReport } from '@mng-review/engine'
import { getVerdict, isFullReview } from './bot-thread.helper'
import type { SummaryMarker } from './publish-marker.schema'
import type { SummaryStanding } from './publish.types'
import {
	getCarriedBugs,
	type MarkedRun,
	type MarkerUpdate,
	toJudgedMarker,
} from './summary-marker.helper'

/** What every standing of one publish run is judged from, whatever marker and update it judges. */
export interface StandingBasis {
	readonly report: ReviewReport
	/** Open bugs the bot's threads hold. */
	readonly threadBugs: number
	/** Threads the run holds waiting for itself only (`toJudgedMarker`). */
	readonly held: readonly string[]
}

/**
 * The verdict, open bugs and whether a full review finished, as a publish run judges them: its
 * thread bugs plus the unthreaded ones the marker carries, and the waiting threads of `marker`, the
 * one the run builds on or wrote, with those the run holds.
 */
export function getPublishStanding(
	basis: StandingBasis,
	marker: SummaryMarker,
	update: MarkerUpdate,
	run: MarkedRun
): SummaryStanding {
	const finished = isFullReview(basis.report, marker, run)
	const openBugs = basis.threadBugs + getCarriedBugs(marker, update)
	const owner = toJudgedMarker(marker, basis.held).needsOwner?.length ?? 0
	return {
		finished,
		openBugs,
		verdict: getVerdict(basis.report, openBugs, finished, owner),
	}
}
