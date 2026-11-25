import type { BotIdentity } from '../../../platform/bot-identity.helper'
import type { PullRequestReview } from '../../../platform/github-api.schema'
import type { SummaryMarker } from '../../publish/domain/publish-marker.schema'
import type { SummaryComment } from '../../publish/domain/publish.types'
import { isIncompleteMarker } from '../../publish/domain/summary-marker.helper'
import { getStaleChangeRequests } from '../../publish/domain/summary-review.helper'

/**
 * The current identity's change requests when nothing open backs one (`unbacked`: no open bug
 * thread, no bug without a thread in the marker on any head, nothing waiting), finished or not. With the marker on the head,
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
 * The bugs without a thread a summary marker holds against `head`: runs on that head left them, so
 * they block it until a full review replaces them; none for a marker on another head.
 */
export function getUnthreadedBugs(
	marker: Pick<SummaryMarker, 'head' | 'unthreadedBugs'> | undefined,
	head: string
): number {
	return marker?.head === head ? (marker.unthreadedBugs ?? 0) : 0
}
