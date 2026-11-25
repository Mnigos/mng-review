import { Context, Effect, Layer } from 'effect'
import { isNotFound } from '../../../platform/github-api.helper'
import { GitHubApiService } from '../../../platform/github-api.service'
import {
	GitHubReviewService,
	REVIEW_EVENT_BY_STATE,
} from '../../../platform/github-review.service'
import { getIncompleteLists } from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	type LatestHead,
	toDecidedSummary,
} from '../domain/review-event.helper'
import { getMarkerError } from '../domain/summary-marker.helper'
import {
	getEditableReview,
	getPriorMarker,
	getPriorSummary,
	hasChangeRequest,
} from '../domain/summary-review.helper'
import { toHeadedSummary } from '../presentation/review-headline.formatter'
import { ReviewPostService, ReviewPostServiceLive } from './review-post.service'
import type {
	PostedReview,
	SummaryDraft,
	SummaryRead,
	SummaryWriteError,
} from './summary-review.service.types'

/** A review a write left, and whether it created it. */
export interface WrittenReviewResult extends PostedReview {
	readonly created: boolean
}

/**
 * Writes the one review a summary write leaves, over the read `SummaryReviewService` made just
 * before, and reads the pull request's head the write decides against.
 */
export class ReviewWriteService extends Context.Service<
	ReviewWriteService,
	{
		/**
		 * Edits the newest summary review when it can be edited (keeping its state), else posts one in
		 * the state `toDecidedSummary` picks; the body's headline names the state it lands in. A run
		 * whose list reads, this write's own included, left a node out never edits an approval: it
		 * posts a `COMMENT` review, so the approval is no longer the newest. It attaches no inline
		 * comment then, and its summary lists their findings and clears no wait. When `found` itself
		 * left a node out, it edits no review at all: it posts one, so that one is the newest.
		 */
		readonly write: (
			pullNumber: number,
			draft: SummaryDraft,
			found: SummaryRead,
			latest: LatestHead
		) => Effect.Effect<WrittenReviewResult, SummaryWriteError, OwnedIdentities>
		/**
		 * The pull request's head, whether the token's identity opened it and whether it is open and
		 * not a draft, read again; a failed read leaves the head and the state unknown, never a draft.
		 * It also names the lists a read of the run so far left a node out of (`getIncompleteLists`).
		 */
		readonly readHead: (
			pullNumber: number
		) => Effect.Effect<LatestHead, never, OwnedIdentities>
	}
>()('mng-review/ReviewWriteService') {}

export const ReviewWriteServiceLive = Layer.effect(
	ReviewWriteService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const github = yield* GitHubReviewService
		const posting = yield* ReviewPostService

		const write = Effect.fn('ReviewWriteService.write')(function* (
			pullNumber: number,
			draft: SummaryDraft,
			found: SummaryRead,
			latest: LatestHead
		) {
			const { identities } = yield* OwnedIdentities
			const changesRequested = hasChangeRequest(found.raw, identities)
			const prior = getPriorSummary(
				found.reviews,
				found.summaries,
				found.hidden
			)
			// A hidden sticky comment only counts: a new marker starts from its runs, never its body.
			const counted = getPriorMarker(
				found.reviews,
				found.summaries,
				found.hidden
			)
			// The write's own read may have hidden a thread an inline comment would repeat.
			const incomplete = latest.incomplete !== undefined
			const decide = (inline: boolean) =>
				toDecidedSummary(
					draft.render(
						prior,
						inline && !incomplete,
						latest.current !== draft.head,
						incomplete,
						counted
					),
					changesRequested,
					latest,
					draft.head
				)
			const fresh = draft.fresh === true || (draft.comments?.length ?? 0) > 0
			const decided = decide(true)
			const unreadable = getMarkerError(decided.rendered.marker)
			if (unreadable) return yield* unreadable
			// The node the read left out may be a newer summary: an edit would leave that one newest.
			const editable = found.incomplete
				? undefined
				: getEditableReview(found.reviews, decided.decision, fresh, {
						head: draft.head,
						current: latest.current,
					})
			// An incomplete run leaves no approval as the app's newest review: it posts a comment over it.
			const keptApproval = incomplete && editable?.state === 'APPROVED'
			if (editable && !keptApproval) {
				const edited = toHeadedSummary(
					decided,
					REVIEW_EVENT_BY_STATE[editable.state]
				)
				const updated = yield* github
					.updateReview(pullNumber, editable.id, edited.rendered.body)
					.pipe(
						Effect.as(true),
						Effect.catchIf(isNotFound, () => Effect.succeed(false))
					)
				if (updated)
					return {
						id: editable.id,
						...edited,
						review: { state: editable.state, commit: editable.commit },
						inline: !incomplete,
						created: false,
					} satisfies WrittenReviewResult
			}
			const posted = yield* posting.post(
				pullNumber,
				incomplete ? { ...draft, comments: [] } : draft,
				toHeadedSummary(decided),
				() => toHeadedSummary(decide(false)),
				found.raw
			)
			return {
				...posted,
				inline: posted.inline && !incomplete,
				created: true,
			} satisfies WrittenReviewResult
		})

		const readHead = Effect.fn('ReviewWriteService.readHead')(function* (
			pullNumber: number
		) {
			const { current } = yield* OwnedIdentities
			const pr = yield* api
				.getPullRequest(pullNumber)
				.pipe(Effect.orElseSucceed(() => undefined))
			const lists = yield* getIncompleteLists
			return {
				current: pr?.head.sha,
				authored: pr?.user?.login.toLowerCase() === current.restLogin,
				...(pr ? { open: pr.state === 'open' && pr.draft !== true } : {}),
				...(lists.length > 0 ? { incomplete: lists } : {}),
			} satisfies LatestHead
		})

		return { write, readHead }
	})
).pipe(Layer.provide(ReviewPostServiceLive))
