import {
	getCombinedLevel,
	getHigherLevel,
	getStepOneLevel,
	type StatusLevel,
	THREAD_RAISE_SEVERITIES,
	type UnratedReason,
} from '@mng-review/domain'
import { CLOSING_REPLY_ACTIONS } from './risk.constants'
import type {
	AnsweredReply,
	FullRatingFacts,
	MarkerRead,
	RatingDecision,
	ThreadRatingFacts,
	WritingDecision,
} from './risk.types'

/** Why a run cannot be rated, with a line for the review body. */
interface Unrated {
	readonly reason: UnratedReason
	readonly detail: string
}

/** The level an edited marker's text names, which step 1 must carry before the rewrite. */
function getMarkerNamed(marker: MarkerRead): StatusLevel {
	return marker.status === 'edited' ? marker.named : 'none'
}

/** Why the marker or the history keeps the run unrated, or `undefined` when they allow a rating. */
function getMarkerGap(
	facts: Pick<FullRatingFacts, 'marker' | 'history'>
): Unrated | undefined {
	if (facts.marker.status === 'failed')
		return {
			reason: 'marker-read-failed',
			detail: 'the risk comment could not be read',
		}
	if (facts.marker.status === 'edited')
		return {
			reason: 'marker-edited',
			detail:
				'someone else edited the risk comment; it is rebuilt from the statuses',
		}
	if (facts.marker.status === 'none' && facts.history)
		return {
			reason: 'history-without-marker',
			detail: 'the pull request was rated before and its risk comment is gone',
		}
	return undefined
}

/** Why a full run is not rated, in the order the checks run, or `undefined` when it is rated. */
function getFullGap(facts: FullRatingFacts): Unrated | undefined {
	const { rating, floors } = facts
	if (!floors)
		return {
			reason: 'publish-failed',
			detail: 'publish could not read the floor diff',
		}
	if (floors.opaque.length > 0)
		return {
			reason: 'opaque-binary',
			detail: `binary outside risk.assets: ${floors.opaque.join(', ')}`,
		}
	if (!rating)
		return { reason: 'run-failed', detail: 'the review carried no rating' }
	// A stored level stands in only for the model's level; an engine gap stays unrated.
	if (rating.status === 'unrated')
		return { reason: rating.reason, detail: rating.detail }
	if (!facts.threadsRead)
		return {
			reason: 'thread-read-failed',
			detail: 'the review threads could not be read',
		}
	return getMarkerGap(facts)
}

/**
 * A full run's decision: rated at the highest of the model's level (or the stored level of the
 * same tree, base and rules, which never stands in for an engine gap), every floor from publish's
 * own diff, Medium for a router `risky`, High for a confirmed High or Critical bug, the marker's
 * highest and the held level; or not rated with the first gap. Step 1 carries the higher of the
 * held level and the level it will publish, raised by what an edited marker names, so no later
 * write holds a level no status has.
 */
export function decideFullRating(facts: FullRatingFacts): WritingDecision {
	const floor = (facts.floors?.hits.length ?? 0) > 0
	const gap = getFullGap(facts)
	const named = getMarkerNamed(facts.marker)
	if (gap)
		return {
			status: 'unrated',
			...gap,
			floor,
			stepOne: getHigherLevel(getStepOneLevel(facts.held), named),
		}
	const { rating, marker } = facts
	const model =
		facts.reused ?? (rating?.status === 'rated' ? rating.model : 'high')
	const level = getCombinedLevel({
		model,
		floors: facts.floors?.hits ?? [],
		routerRisky: facts.routerRisky,
		confirmedBugs: facts.confirmedBugs,
		markerHighest: marker.status === 'trusted' ? marker.marker.highest : 'none',
		held: facts.held,
	})
	return {
		status: 'rated',
		level,
		floor,
		stepOne: getStepOneLevel(facts.held, level),
	}
}

/** True when the threads show an open confirmed bug at High or Critical. */
export function hasThreadRaise(confirmedBugs: readonly string[]): boolean {
	return confirmedBugs.some(severity =>
		THREAD_RAISE_SEVERITIES.some(raise => raise === severity)
	)
}

/**
 * A thread run's decision (`run <agent>`, reply-only, converse, the sweep's thread check): a failed
 * thread read or a marker it cannot trust leaves the head unrated at the held level; an open
 * confirmed High or Critical bug raises it to High; anything else writes nothing.
 */
export function decideThreadRating(facts: ThreadRatingFacts): RatingDecision {
	const named = getMarkerNamed(facts.marker)
	const unrated = (gap: Unrated): WritingDecision => ({
		status: 'unrated',
		...gap,
		floor: false,
		stepOne: getHigherLevel(getStepOneLevel(facts.held), named),
	})
	if (!facts.threadsRead)
		return unrated({
			reason: 'thread-read-failed',
			detail: 'the review threads could not be read',
		})
	const gap = getMarkerGap(facts)
	if (gap) return unrated(gap)
	if (!hasThreadRaise(facts.confirmedBugs)) return { status: 'none' }
	return {
		status: 'rated',
		level: 'high',
		floor: false,
		stepOne: 'high',
	}
}

/**
 * The bot threads a reply run answered without closing them, known before any answer is posted:
 * the thread raise counts them as open even when GitHub still shows them resolved, so a run that
 * fails after posting still raises for them.
 */
export function getAnsweredOpenThreads(
	decisions: readonly AnsweredReply[]
): string[] {
	return decisions
		.filter(
			entry =>
				!CLOSING_REPLY_ACTIONS.some(action => action === entry.decision.action)
		)
		.map(entry => entry.threadId)
}
