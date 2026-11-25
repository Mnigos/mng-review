import {
	type BotIdentity,
	isIdentity,
	isOwnedBot,
} from '../../../platform/bot-identity.helper'
import type {
	PullRequestReview,
	ReviewState,
} from '../../../platform/github-api.schema'
import { REVIEW_STATE_BY_EVENT } from '../../../platform/github-review.service'
import { isBotComment } from './bot-thread.helper'
import { parseSummaryMarker } from './publish-marker.parser'
import type { SummaryMarker } from './publish-marker.schema'
import { MARKER_VERSION } from './publish.constants'
import type { SummaryComment, SummaryReview } from './publish.types'
import type { ReviewDecision } from './review-event.helper'
import { getSummary } from './summary-comment.helper'
import { toCountedMarker, toReadMarker } from './summary-marker.helper'

/** States that block or approve; a review in one of them stands for its own commit only. */
const VERDICT_STATES: ReadonlySet<ReviewState> = new Set([
	'APPROVED',
	'CHANGES_REQUESTED',
])

/** The review a write left: its state and commit. The write's own review is always the current identity's. */
export type WrittenReview = Pick<SummaryReview, 'state' | 'commit'>

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
		const mine = isIdentity(review.author, current)
		return [
			{
				id: review.databaseId,
				nodeId: review.id,
				marker: toReadMarker(marker, mine),
				body: review.body,
				mine,
				state: review.state,
				commit: review.commit?.oid,
				minimized: review.isMinimized,
			},
		]
	})
}

/**
 * The summary a run builds on: the newest summary review of any owned identity, or with none the
 * old sticky comment (`getSummary`), so the run count and the waiting list carry over. Its run
 * counts are the most any listed summary holds (`toCountedMarker`), the `hidden` sticky comments
 * (`toHiddenSummaryComments`) included, which it never builds on.
 */
export function getPriorSummary(
	reviews: readonly SummaryReview[],
	comments: readonly SummaryComment[],
	hidden: readonly SummaryComment[] = []
): SummaryComment | undefined {
	const prior = reviews.at(-1) ?? getSummary(comments)
	if (!prior) return undefined
	const listed = [...reviews, ...comments, ...hidden].map(
		summary => summary.marker
	)
	const marker = toCountedMarker(prior.marker, listed)
	if (
		marker.runs === prior.marker.runs &&
		marker.manualRuns === prior.marker.manualRuns
	)
		return prior
	return { ...prior, marker }
}

/**
 * The marker a run counts from: the prior summary's (`getPriorSummary`), or with no visible
 * summary a new one that carries only the counts of the `hidden` sticky comments, since no run
 * builds on, edits or cleans up a hidden one.
 */
export function getPriorMarker(
	reviews: readonly SummaryReview[],
	comments: readonly SummaryComment[],
	hidden: readonly SummaryComment[]
): SummaryMarker | undefined {
	const prior = getPriorSummary(reviews, comments, hidden)
	if (prior || hidden.length === 0) return prior?.marker
	return toCountedMarker(
		{ v: MARKER_VERSION, runs: 0, finished: false },
		hidden.map(summary => summary.marker)
	)
}

/** The head a run reviewed and the pull request's head as publishing read it again, unset when that read failed. */
export interface WriteHeads {
	readonly head: string
	readonly current: string | undefined
}

/**
 * The review a write edits instead of posting a new one: the newest summary review, when the
 * current identity wrote it, it is not hidden and the run posts no new thread; and its state is the
 * one the run posts, or any state when the run keeps it. An approval or change request stands for
 * its commit, so it is edited only by a run on that commit while it is the current head: one on an
 * older commit, or one on the current head while the run reviewed another, gets a new review.
 */
export function getEditableReview(
	reviews: readonly SummaryReview[],
	decision: Pick<ReviewDecision, 'event' | 'keep'>,
	fresh: boolean,
	heads: WriteHeads
): SummaryReview | undefined {
	const latest = reviews.at(-1)
	if (fresh || !latest?.mine || latest.minimized) return undefined
	if (
		VERDICT_STATES.has(latest.state) &&
		(heads.current === undefined ||
			latest.commit !== heads.current ||
			heads.head !== heads.current)
	)
		return undefined
	if (decision.keep) return latest
	return latest.state === REVIEW_STATE_BY_EVENT[decision.event]
		? latest
		: undefined
}

/**
 * True when an owned identity's standing verdict requests changes: its newest review that approves
 * or requests changes, dismissed ones aside, so a change request a later approval superseded does
 * not stand.
 */
export function hasChangeRequest(
	reviews: readonly PullRequestReview[],
	owned: readonly BotIdentity[]
): boolean {
	return owned.some(
		identity =>
			reviews.findLast(
				review =>
					VERDICT_STATES.has(review.state) &&
					isIdentity(review.author, identity)
			)?.state === 'CHANGES_REQUESTED'
	)
}

/**
 * The ids of the owned change requests a clearing write leaves stale (`ReviewDecision.clears`):
 * every one, except the current identity's own after an approval, which replaces it. None after
 * any other write.
 */
export function getStaleChangeRequests(
	reviews: readonly PullRequestReview[],
	owned: readonly BotIdentity[],
	current: BotIdentity,
	decision: Pick<ReviewDecision, 'event' | 'clears'>
): readonly number[] {
	if (!decision.clears) return []
	return reviews.flatMap(review =>
		review.state === 'CHANGES_REQUESTED' &&
		review.databaseId !== null &&
		isOwnedBot(review.author, owned) &&
		(decision.event !== 'APPROVE' || !isIdentity(review.author, current))
			? [review.databaseId]
			: []
	)
}

/**
 * The ids of the owned approvals that outlived their head once `written` is on the pull request.
 * `heads.current` is the pull request's head as publishing read it again. An approval on the
 * current head stays whenever the run reviewed another head, and with that head unread none is
 * dismissed, since none is known to be stale. Otherwise: every approval of another owned identity,
 * which the write replaces, on the current head only when the run reviewed it; and unless the
 * write left the current identity's approval on the current head, the current identity's approvals
 * on another commit (or none read).
 */
export function getStaleApprovals(
	reviews: readonly PullRequestReview[],
	owned: readonly BotIdentity[],
	current: BotIdentity,
	heads: WriteHeads,
	written: WrittenReview
): readonly number[] {
	const head = heads.current
	if (head === undefined) return []
	const approvedHere = written.state === 'APPROVED' && written.commit === head
	const offHead = (review: PullRequestReview) => review.commit?.oid !== head
	return reviews.flatMap(review =>
		review.state === 'APPROVED' &&
		review.databaseId !== null &&
		isOwnedBot(review.author, owned) &&
		(isIdentity(review.author, current)
			? !approvedHere && offHead(review)
			: heads.head === head || offHead(review))
			? [review.databaseId]
			: []
	)
}

/** The review a write left: its id, state and commit, and whether the write posted it. */
export interface LeftReview {
	readonly id: number
	readonly review: WrittenReview
	readonly created: boolean
}

/**
 * The review a write just left, when it outlived its head: its commit is not the current head as
 * read after the write, because a push landed between the two reads. An approval always goes; a
 * change request goes only when this write posted it, since one it edited may still have its
 * evidence and stays until a clearing write. Unset when that read failed, since the review is not
 * known to be stale.
 */
export function getOutlivedReview(
	written: LeftReview,
	current: string | undefined
): number | undefined {
	const { review } = written
	if (current === undefined || review.commit === current) return undefined
	if (review.state === 'APPROVED') return written.id
	return review.state === 'CHANGES_REQUESTED' && written.created
		? written.id
		: undefined
}

/**
 * Earlier reviews of an owned identity a write hides as outdated: unedited, visible, with a body,
 * other than the one the write kept. The bot's reviews from before the summary moved into them
 * ("N new comment(s)") have no marker and are hidden too. An approval or change request on the
 * current head stays visible when the run reviewed another head, and every one when the current
 * head could not be read: neither is known to be outdated.
 */
export function getStaleReviews(
	reviews: readonly PullRequestReview[],
	owned: readonly BotIdentity[],
	kept: number | undefined,
	heads?: WriteHeads
): readonly PullRequestReview[] {
	const standing = (review: PullRequestReview) =>
		heads !== undefined &&
		VERDICT_STATES.has(review.state) &&
		(heads.current === undefined ||
			(heads.head !== heads.current && review.commit?.oid === heads.current))
	return reviews.filter(
		review =>
			review.databaseId !== kept &&
			!review.isMinimized &&
			review.body.trim() !== '' &&
			isBotComment(review, owned) &&
			!standing(review)
	)
}
