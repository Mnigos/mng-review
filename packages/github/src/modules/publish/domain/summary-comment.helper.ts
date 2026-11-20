import {
	type BotIdentity,
	isIdentity,
} from '../../../platform/bot-identity.helper'
import type { PullRequestComment } from '../../../platform/github-api.schema'
import { isBotComment } from './bot-thread.helper'
import { parseSummaryMarker } from './publish-marker.parser'
import type { SummaryCleanup, SummaryComment } from './publish.types'

/** The order a cleanup reports its worst outcome in. */
const CLEANUP_RANK = {
	none: 0,
	minimized: 1,
	deleted: 2,
	kept: 3,
} as const satisfies Record<SummaryCleanup, number>

/**
 * The sticky summaries among the pull request's comments, oldest first: comments of an owned bot,
 * unedited by anyone else, not hidden, that end with a summary marker. `mine` marks the ones the
 * current identity wrote.
 */
export function toSummaryComments(
	comments: readonly PullRequestComment[],
	owned: readonly BotIdentity[],
	current: BotIdentity
): readonly SummaryComment[] {
	return comments.flatMap((comment): SummaryComment[] => {
		if (
			comment.databaseId === null ||
			comment.isMinimized ||
			!isBotComment(comment, owned)
		)
			return []
		const marker = parseSummaryMarker(comment.body)
		if (!marker) return []
		return [
			{
				id: comment.databaseId,
				nodeId: comment.id,
				marker,
				body: comment.body,
				mine: isIdentity(comment.author, current),
			},
		]
	})
}

/**
 * The summary a run builds on: the current identity's oldest, or else the oldest of any owned
 * identity, whose marker is then only the prior state and is never edited.
 */
export function getSummary(
	summaries: readonly SummaryComment[]
): SummaryComment | undefined {
	return summaries.find(summary => summary.mine) ?? summaries[0]
}

/** The current identity's oldest summary, if it wrote one. */
export function getOwnSummary(
	summaries: readonly SummaryComment[]
): SummaryComment | undefined {
	return summaries.find(summary => summary.mine)
}

/**
 * The current identity's summaries after its oldest: duplicates two runs created at once. A write
 * deletes them, keeping the oldest.
 */
export function getDuplicateSummaries(
	summaries: readonly SummaryComment[]
): readonly SummaryComment[] {
	return summaries.filter(summary => summary.mine).slice(1)
}

/** Summaries of other owned identities that are still visible; a write hides them. */
export function getStaleSummaries(
	summaries: readonly SummaryComment[]
): readonly SummaryComment[] {
	return summaries.filter(summary => !summary.mine)
}

/** The worst outcome of a cleanup: `kept` over `deleted` over `minimized`; `none` when nothing was stale. */
export function toSummaryCleanup(
	outcomes: readonly SummaryCleanup[]
): SummaryCleanup {
	return outcomes.reduce<SummaryCleanup>(
		(worst, outcome) =>
			CLEANUP_RANK[outcome] > CLEANUP_RANK[worst] ? outcome : worst,
		'none'
	)
}

/**
 * The thread ids every summary of an owned identity lists as waiting for the owner, hidden ones
 * included: a writer may hide the bot's summary, but cannot write one, so a hidden list still holds.
 */
export function getListedWaiting(
	comments: readonly PullRequestComment[],
	owned: readonly BotIdentity[]
): string[] {
	const ids = comments.flatMap(comment =>
		isBotComment(comment, owned)
			? (parseSummaryMarker(comment.body)?.needsOwner ?? [])
			: []
	)
	return [...new Set(ids)]
}
