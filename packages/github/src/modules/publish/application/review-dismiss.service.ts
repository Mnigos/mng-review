import { Context, Effect, Layer } from 'effect'
import type { PullRequestReview } from '../../../platform/github-api.schema'
import { GitHubReviewService } from '../../../platform/github-review.service'
import { isReadIncomplete } from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import type { DismissalOutcome } from '../domain/publish.types'
import {
	getOutlivedReview,
	getStaleApprovals,
	getStaleChangeRequests,
	type WriteHeads,
} from '../domain/summary-review.helper'
import {
	toClearedMessage,
	toOutlivedReviewMessage,
	toReplacedApprovalMessage,
	toStaleApprovalMessage,
} from '../presentation/summary-status.formatter'
import type { PostedReview } from './summary-review.service.types'

/** A write the dismissals follow: its decision and the review it left, with that review's id. */
export interface DismissedAfter extends Pick<
	PostedReview,
	'id' | 'decision' | 'review'
> {
	/** The write posted this review rather than edited an earlier one. */
	readonly created: boolean
}

/** What the dismissals after a write did, and whether one dismissed the review the write left. */
export interface StaleDismissal extends DismissalOutcome {
	readonly outlived: boolean
}

/** Nothing dismissed. */
const NOTHING_DISMISSED = {
	dismissed: 0,
	failed: 0,
} as const satisfies DismissalOutcome

/**
 * Dismisses the bot's reviews that no longer hold. Dismissals run one at a time; one GitHub refuses
 * or never answers counts as failed, is reported, and is left for the next run.
 */
export class ReviewDismissService extends Context.Service<
	ReviewDismissService,
	{
		/** Dismisses each review with `message`. */
		readonly dismiss: (
			pullNumber: number,
			ids: readonly number[],
			message: string
		) => Effect.Effect<DismissalOutcome>
		/**
		 * Dismisses the change requests `ids` with `message`, and none once a list read of the run
		 * left a node out (`isReadIncomplete`): a thread or review it could not see may still back
		 * them. Every change-request dismissal goes through it.
		 */
		readonly liftRequests: (
			pullNumber: number,
			ids: readonly number[],
			message: string
		) => Effect.Effect<DismissalOutcome>
		/**
		 * After a write: the owned change requests a clearing write leaves stale
		 * (`getStaleChangeRequests`, through `liftRequests`) and the owned approvals that outlived
		 * the current head (`getStaleApprovals`), among `reviews` as read before the write, and the
		 * review the write left when a push landed right after it (`getOutlivedReview`; a change
		 * request through `liftRequests`). An incomplete run still dismisses the approvals and an
		 * outlived approval, which only lowers approval.
		 */
		readonly dismissStale: (
			pullNumber: number,
			heads: WriteHeads,
			reviews: readonly PullRequestReview[],
			written: DismissedAfter
		) => Effect.Effect<StaleDismissal, never, OwnedIdentities>
	}
>()('mng-review/ReviewDismissService') {}

export const ReviewDismissServiceLive = Layer.effect(
	ReviewDismissService,
	Effect.gen(function* () {
		const github = yield* GitHubReviewService

		const dismiss = Effect.fn('ReviewDismissService.dismiss')(function* (
			pullNumber: number,
			ids: readonly number[],
			message: string
		) {
			const results = yield* Effect.forEach(
				ids,
				id =>
					github.dismissReview(pullNumber, id, message).pipe(
						Effect.as(true),
						Effect.orElseSucceed(() => false)
					),
				{ concurrency: 1 }
			)
			const dismissed = results.filter(Boolean).length
			return {
				dismissed,
				failed: results.length - dismissed,
			} satisfies DismissalOutcome
		})

		const liftRequests = Effect.fn('ReviewDismissService.liftRequests')(
			function* (pullNumber: number, ids: readonly number[], message: string) {
				// A list read that left a node out may miss the thread or review that keeps a request.
				if (ids.length === 0 || (yield* isReadIncomplete))
					return NOTHING_DISMISSED
				return yield* dismiss(pullNumber, ids, message)
			}
		)

		const dismissStale = Effect.fn('ReviewDismissService.dismissStale')(
			function* (
				pullNumber: number,
				heads: WriteHeads,
				reviews: readonly PullRequestReview[],
				written: DismissedAfter
			) {
				const { current, identities } = yield* OwnedIdentities
				// A push that landed after the write leaves the clearing evidence on an older head.
				const cleared = heads.current === heads.head
				const requests = yield* liftRequests(
					pullNumber,
					cleared
						? getStaleChangeRequests(
								reviews,
								identities,
								current,
								written.decision
							)
						: [],
					toClearedMessage(heads.head)
				)
				// The review this write left is judged once, by `getOutlivedReview` below.
				const stale = getStaleApprovals(
					reviews,
					identities,
					current,
					heads,
					written.review
				).filter(id => id !== written.id)
				// On the current head only another identity's approval is stale: this identity's replaces it.
				const onHead = new Set(
					reviews
						.filter(review => review.commit?.oid === heads.current)
						.map(review => review.databaseId)
				)
				const latest = heads.current ?? heads.head
				const approvals = yield* dismiss(
					pullNumber,
					stale.filter(id => !onHead.has(id)),
					toStaleApprovalMessage(latest)
				)
				const replaced = yield* dismiss(
					pullNumber,
					stale.filter(id => onHead.has(id)),
					toReplacedApprovalMessage(latest)
				)
				// The read before the write did not hold the review it just left.
				const outlived = getOutlivedReview(written, heads.current)
				const own = yield* (
					written.review.state === 'CHANGES_REQUESTED' ? liftRequests : dismiss
				)(
					pullNumber,
					outlived === undefined ? [] : [outlived],
					toOutlivedReviewMessage(latest)
				)
				return {
					dismissed:
						requests.dismissed +
						approvals.dismissed +
						replaced.dismissed +
						own.dismissed,
					failed:
						requests.failed + approvals.failed + replaced.failed + own.failed,
					outlived: own.dismissed > 0,
				} satisfies StaleDismissal
			}
		)

		return { dismiss, liftRequests, dismissStale }
	})
)
