import { Context, Effect, Layer, Result } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubReviewService } from '../../../platform/github-review.service'
import { GitHubStatusService } from '../../../platform/github-status.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import {
	isReadIncomplete,
	restartListCount,
} from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	ReviewDismissService,
	ReviewDismissServiceLive,
} from '../../publish/application/review-dismiss.service'
import { ThreadReplyServiceLive } from '../../publish/application/thread-reply.service'
import type { DismissalOutcome } from '../../publish/domain/publish.types'
import type { ReviewDecision } from '../../publish/domain/review-event.helper'
import { getStaleChangeRequests } from '../../publish/domain/summary-review.helper'
import { toClearedMessage } from '../../publish/presentation/summary-status.formatter'
import { PullStateService, PullStateServiceLive } from './pull-state.service'

/** The open pull requests with a lift due, and how many were read and how many of those failed. */
export interface LiftFindResult {
	/** Numbers in the order GitHub listed them. */
	readonly pulls: readonly number[]
	readonly read: number
	readonly failed: number
}

/**
 * What a lift found on its pull request: `closed` when it is no longer open, `incomplete` when a
 * list read left a node out, `not-due` when something backs every change request or none is left,
 * `moved` when the head moved before the dismissal, and `lifted` when it dismissed.
 */
export type LiftOutcome =
	| 'closed'
	| 'incomplete'
	| 'not-due'
	| 'moved'
	| 'lifted'

/** What a lift did on one pull request. */
export interface LiftResult {
	readonly outcome: LiftOutcome
	/** The pull request's head the lift judged; unset when it is closed. */
	readonly head?: string
	readonly dismissal: DismissalOutcome
}

/** Nothing dismissed. */
const NO_DISMISSAL = {
	dismissed: 0,
	failed: 0,
} as const satisfies DismissalOutcome

/** A write that clears, as `getStaleChangeRequests` takes it: every owned change request is stale. */
const CLEARING = {
	event: 'COMMENT',
	clears: true,
} as const satisfies Pick<ReviewDecision, 'event' | 'clears'>

/**
 * Lifts the current identity's change requests nothing backs any more, which a person resolving
 * the last thread by hand leaves: no open bug thread, no bug without a thread on the marker's head,
 * nothing waiting for the owner and no summary an incomplete write left, with every list read
 * complete (`PullStateService.read`). Only the reply schedule's jobs run it, and only the locked
 * one dismisses: `findDue` lists the pull requests with a lift due from the find job, which holds a
 * read-only token, and `lift` judges one of them again in a job that holds the pull request's
 * publish group (`mng-review-publish-<number>`), so no publishing run writes threads, a summary or
 * a status between its judgment and its dismissal. A person can still reopen a thread in between;
 * nothing restores a change request once dismissed.
 */
export class RequestLiftService extends Context.Service<
	RequestLiftService,
	{
		/** The open pull requests with a lift due; one whose read fails is skipped and counted. */
		readonly findDue: (
			allow: readonly string[]
		) => Effect.Effect<LiftFindResult, GitHubApiError, OwnedIdentities>
		/**
		 * Reads the pull request and judges it again; while a lift is still due and a read of the head
		 * right before the dismissal shows the head it judged, dismisses the change requests it judged
		 * stale (`ReviewDismissService.liftRequests`). It writes no status.
		 */
		readonly lift: (
			pullNumber: number,
			allow: readonly string[]
		) => Effect.Effect<LiftResult, GitHubApiError, OwnedIdentities>
	}
>()('mng-review/RequestLiftService') {}

export const RequestLiftServiceLive = Layer.effect(
	RequestLiftService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const reviewsApi = yield* GitHubReviewService
		const github = yield* GitHubStatusService
		const pulls = yield* PullStateService
		const dismissals = yield* ReviewDismissService

		/** The change requests to lift on `head`; none when nothing is due. */
		const getDue = Effect.fn('RequestLiftService.getDue')(function* (
			pullNumber: number,
			head: string,
			allow: readonly string[]
		) {
			const { current } = yield* OwnedIdentities
			// Reviews first: a change request posted after this read is never lifted by this judgment.
			const reviews = yield* reviewsApi.listReviews(pullNumber, true)
			// Only the current identity's change requests are lifted; with none, nothing else is read.
			if (
				getStaleChangeRequests(reviews, [current], current, CLEARING).length ===
				0
			)
				return []
			const state = yield* pulls.read({ pullNumber, head, reviews, allow })
			return state.kind === 'read' ? state.stale : []
		})

		const findDue = Effect.fn('RequestLiftService.findDue')(function* (
			allow: readonly string[]
		) {
			const open = yield* github.listOpenPullRequests()
			// Each pull request counts its own left-out nodes, so one never holds another back.
			const judged = yield* Effect.forEach(
				open,
				pr =>
					Effect.result(
						getDue(pr.number, pr.head.sha, allow).pipe(restartListCount)
					),
				{ concurrency: 1 }
			)
			return {
				pulls: open.flatMap((pr, index) => {
					const entry = judged[index]
					return entry && Result.isSuccess(entry) && entry.success.length > 0
						? [pr.number]
						: []
				}),
				read: open.length,
				failed: judged.filter(Result.isFailure).length,
			} satisfies LiftFindResult
		})

		const lift = Effect.fn('RequestLiftService.lift')(function* (
			pullNumber: number,
			allow: readonly string[]
		) {
			const pr = yield* api.getPullRequest(pullNumber)
			if (pr.state !== 'open')
				return {
					outcome: 'closed',
					dismissal: NO_DISMISSAL,
				} satisfies LiftResult
			const head = pr.head.sha
			const stale = yield* getDue(pullNumber, head, allow)
			if (yield* isReadIncomplete)
				return {
					outcome: 'incomplete',
					head,
					dismissal: NO_DISMISSAL,
				} satisfies LiftResult
			if (stale.length === 0)
				return {
					outcome: 'not-due',
					head,
					dismissal: NO_DISMISSAL,
				} satisfies LiftResult
			// The head again right before dismissing: a push since the judgment keeps every request.
			if ((yield* api.getPullRequest(pullNumber)).head.sha !== head)
				return {
					outcome: 'moved',
					head,
					dismissal: NO_DISMISSAL,
				} satisfies LiftResult
			return {
				outcome: 'lifted',
				head,
				dismissal: yield* dismissals.liftRequests(
					pullNumber,
					stale,
					toClearedMessage(head)
				),
			} satisfies LiftResult
		})

		return { findDue, lift }
	})
).pipe(
	Layer.provide(
		Layer.mergeAll(PullStateServiceLive, ReviewDismissServiceLive).pipe(
			Layer.provide(ThreadReplyServiceLive)
		)
	)
)
