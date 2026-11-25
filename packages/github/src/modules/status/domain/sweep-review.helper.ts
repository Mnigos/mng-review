import type { BotIdentity } from '../../../platform/bot-identity.helper'
import type { PullRequestReview } from '../../../platform/github-api.schema'
import type { SummaryMarker } from '../../publish/domain/publish-marker.schema'
import type { SummaryComment } from '../../publish/domain/publish.types'
import { isIncompleteMarker } from '../../publish/domain/summary-marker.helper'
import {
	getPriorSummary,
	getStaleChangeRequests,
	toSummaryReviews,
} from '../../publish/domain/summary-review.helper'
import type { CommitStatusText } from './status.helper'

/**
 * The current identity's change requests when nothing open backs one (`unbacked`: no open bug
 * thread, no bug without a thread, nothing waiting), finished or not. With the marker on the head,
 * every one; with it on another head, which an unfinished full run leaves, only those on a known
 * commit other than `head`, the pull request's head: one whose commit is unknown is kept. None
 * while the marker is one an incomplete write left (`isIncompleteMarker`), which may miss what
 * backs one.
 */
export function getUnbackedRequests(
	reviews: readonly PullRequestReview[],
	current: BotIdentity,
	head: string,
	marker: Pick<SummaryMarker, 'head' | 'finished' | 'failed'> | undefined,
	unbacked: boolean
): readonly number[] {
	if (!unbacked || !marker || isIncompleteMarker(marker)) return []
	const candidates =
		marker.head === head
			? reviews
			: reviews.filter(
					review =>
						review.commit?.oid !== undefined && review.commit.oid !== head
				)
	return getStaleChangeRequests(candidates, [current], current, {
		event: 'COMMENT',
		clears: true,
	})
}

/**
 * Whether the last full run finished on `head`, as the sweep reads the summary: a marker's finished
 * flag is its head's, since a partial run on another head keeps it. A previous identity's marker
 * stopped at the switch, so off its head it says nothing (`undefined`) and the status already set
 * decides. A marker an incomplete write left (`isIncompleteMarker`) never finished, whoever wrote it.
 */
export function getSweptFinished(
	summary: Pick<SummaryComment, 'mine' | 'marker'> | undefined,
	head: string
): boolean | undefined {
	const marker = summary?.marker
	if (isIncompleteMarker(marker)) return false
	const onHead = marker?.head === head
	if (!summary?.mine && !onHead) return undefined
	return marker?.finished && onHead
}

/**
 * The ids of `ids` whose review a later read still shows with the body and state of the first
 * read: one edited in place meanwhile can carry new evidence, so it is not dismissed.
 */
export function getUnchangedReviews(
	ids: readonly number[],
	before: readonly PullRequestReview[],
	after: readonly PullRequestReview[]
): readonly number[] {
	return ids.filter(id => {
		const first = before.find(review => review.databaseId === id)
		const latest = after.find(review => review.databaseId === id)
		return (
			first !== undefined &&
			latest?.body === first.body &&
			latest.state === first.state
		)
	})
}

/**
 * True when the sweep reads the reviews again before it decides the status: it has a change request
 * to dismiss (`stale`), or would write `success` (`planned`), which only that read can back.
 */
export function isConfirmDue(
	stale: readonly number[],
	planned: Pick<CommitStatusText, 'state'> | undefined
): boolean {
	return stale.length > 0 || planned?.state === 'success'
}

/** The summary the sweep judged first and the reviews its confirming read listed, if it made one. */
export interface SweptSummaries {
	readonly summary: SummaryComment | undefined
	/** The confirming review read; unset when the sweep made none or it failed. */
	readonly latest: readonly PullRequestReview[] | undefined
	/** The sticky summaries of the first read, which the confirming read does not repeat. */
	readonly summaries: readonly SummaryComment[]
	readonly owned: readonly BotIdentity[]
	readonly current: BotIdentity
}

/**
 * The summary the sweep decides from: the newest in its confirming review read, which a run that
 * landed between the two review reads may have posted, else the one it judged first.
 */
export function getConfirmedSummary(
	summaries: SweptSummaries
): SummaryComment | undefined {
	if (!summaries.latest) return summaries.summary
	const reviews = toSummaryReviews(
		summaries.latest,
		summaries.owned,
		summaries.current
	)
	return getPriorSummary(reviews, summaries.summaries)
}

/**
 * True when the sweep holds on a marker an incomplete write left (`isIncompleteMarker`): the one it
 * judged first, or the newest in its confirming review read (`getConfirmedSummary`).
 */
export function isSweptUnfinished(summaries: SweptSummaries): boolean {
	return (
		isIncompleteMarker(summaries.summary?.marker) ||
		isIncompleteMarker(getConfirmedSummary(summaries)?.marker)
	)
}

/**
 * The bugs without a thread a summary marker holds against `head`: runs on that head left them, so
 * they block it until a full review replaces them; none for a marker on another head.
 */
export function getUnthreadedBugs(
	marker: Pick<SummaryMarker, 'head' | 'unthreadedBugs'> | undefined,
	head: string
): number {
	return marker?.head === head ? (marker.unthreadedBugs ?? 0) : 0
}

/**
 * The threads the confirming read's newest summary (`confirmed`) lists as waiting for the owner when
 * a run wrote it between the sweep's two review reads, as another summary or the first one edited:
 * that run judged them, so they hold whether or not the sweep saw them cleared. None while the sweep
 * decides from the summary it judged first (`summary`).
 */
export function getConfirmedWaiting(
	summary: Pick<SummaryComment, 'id' | 'body'> | undefined,
	confirmed: Pick<SummaryComment, 'id' | 'body' | 'marker'> | undefined
): readonly string[] {
	if (
		!confirmed ||
		(confirmed.id === summary?.id && confirmed.body === summary.body)
	)
		return []
	return confirmed.marker.needsOwner ?? []
}

/**
 * The status the sweep writes once its confirming read decided `recomputed`: that read can only
 * hold back the `success` the sweep planned (`planned`), never raise a plan to one, and a failed
 * read (`readFailed`) backs none; `undefined` writes nothing.
 */
export function toConfirmedStatus(
	planned: CommitStatusText | undefined,
	recomputed: CommitStatusText | undefined,
	readFailed: boolean
): CommitStatusText | undefined {
	if (recomputed?.state !== 'success') return recomputed
	return planned?.state === 'success' && !readFailed ? recomputed : undefined
}

/**
 * True when the confirming read turned the sweep's plan (`planned`) aside: it holds back a planned
 * `success`, or would raise a plan to one, which `toConfirmedStatus` drops. Either way the sweep lifts
 * no change request.
 */
export function isPlanTurned(
	planned: Pick<CommitStatusText, 'state'> | undefined,
	recomputed: Pick<CommitStatusText, 'state'> | undefined
): boolean {
	return (planned?.state === 'success') !== (recomputed?.state === 'success')
}
