import { type ReplyStanding, toReplyStanding } from './bot-thread.helper'
import type { SummaryMarker } from './publish-marker.schema'
import {
	type StoredWaitInput,
	toJudgedMarker,
	toRepliedMarker,
	toStoredWaits,
} from './summary-marker.helper'

/** What a reply-only run judges a summary with: its owner waits, its head and its thread bugs. */
export interface ReplyJudgeInput {
	readonly waits: StoredWaitInput
	readonly head: string
	/** Open confirmed bug threads after the run's answers. */
	readonly threadBugs: number
}

/**
 * A reply-only run's view of a summary: the marker it writes, that marker with the threads it
 * holds for itself only (`judging`, never written), and the standing it judges from that.
 */
export interface ReplyJudgement {
	readonly marker: SummaryMarker
	readonly judging: SummaryMarker
	readonly standing: ReplyStanding
}

/**
 * What a reply-only run judges of the summary marker `prior`: the waits it stores
 * (`toStoredWaits`, none cleared when `incomplete`), the marker it writes over `prior` and the
 * standing of the summary's head. A failed write sets the status from the same judgement.
 */
export function toReplyJudgement(
	prior: SummaryMarker | undefined,
	incomplete: boolean,
	input: ReplyJudgeInput
): ReplyJudgement {
	const { update, held } = toStoredWaits(input.waits, incomplete)
	const marker = toRepliedMarker(prior, update)
	const judging = toJudgedMarker(marker, held)
	return {
		marker,
		judging,
		standing: toReplyStanding(judging, input.head, input.threadBugs),
	}
}
