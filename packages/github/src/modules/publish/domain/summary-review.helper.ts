import {
	type BotIdentity,
	isIdentity,
} from '../../../platform/bot-identity.helper'
import type {
	PullRequestReview,
	ReviewState,
} from '../../../platform/github-api.schema'
import { isBotComment } from './bot-thread.helper'
import { parseSummaryMarker } from './publish-marker.parser'
import type { SummaryComment, SummaryReview } from './publish.types'
import { getSummary } from './summary-comment.helper'

/**
 * The summary reviews among the pull request's reviews, oldest first: reviews of an owned bot,
 * unedited by anyone else, whose body ends with a summary marker. Hidden and dismissed reviews
 * count: their bodies stay readable, and a writer can hide the bot's review but cannot write one.
 */
export function toSummaryReviews(
	reviews: readonly PullRequestReview[],
	owned: readonly BotIdentity[],
	current: BotIdentity
): readonly SummaryReview[] {
	return reviews.flatMap((review): SummaryReview[] => {
		if (review.databaseId === null || !isBotComment(review, owned)) return []
		const marker = parseSummaryMarker(review.body)
		if (!marker) return []
		return [
			{
				id: review.databaseId,
				nodeId: review.id,
				marker,
				body: review.body,
				mine: isIdentity(review.author, current),
				state: review.state,
				minimized: review.isMinimized,
			},
		]
	})
}

/**
 * The summary a run builds on: the newest summary review of any owned identity, or with none the
 * old sticky comment (`getSummary`), so the run count and the waiting list carry over.
 */
export function getPriorSummary(
	reviews: readonly SummaryReview[],
	comments: readonly SummaryComment[]
): SummaryComment | undefined {
	return reviews.at(-1) ?? getSummary(comments)
}

/**
 * The review a write edits instead of posting a new one: the newest summary review, when the
 * current identity wrote it, it is not hidden, its state is the one the run would post, and the
 * run posts no new thread. Otherwise the run posts a new review.
 */
export function getEditableReview(
	reviews: readonly SummaryReview[],
	state: ReviewState,
	fresh: boolean
): SummaryReview | undefined {
	const latest = reviews.at(-1)
	if (fresh || !latest?.mine || latest.minimized || latest.state !== state)
		return undefined
	return latest
}

/**
 * Earlier reviews of an owned identity a write hides as outdated: unedited, visible, with a body,
 * other than the one the write kept. The bot's reviews from before the summary moved into them
 * ("N new comment(s)") have no marker and are hidden too.
 */
export function getStaleReviews(
	reviews: readonly PullRequestReview[],
	owned: readonly BotIdentity[],
	kept: number | undefined
): readonly PullRequestReview[] {
	return reviews.filter(
		review =>
			review.databaseId !== kept &&
			!review.isMinimized &&
			review.body.trim() !== '' &&
			isBotComment(review, owned)
	)
}
