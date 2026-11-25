import { Context, Effect, Layer, Result } from 'effect'
import type { BotIdentity } from '../../../platform/bot-identity.helper'
import type {
	CommitStatus,
	PullRequestReview,
} from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubReviewService } from '../../../platform/github-review.service'
import { GitHubStatusService } from '../../../platform/github-status.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import {
	getIncompleteLists,
	isReadIncomplete,
	restartListCount,
} from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	ReviewDismissService,
	ReviewDismissServiceLive,
} from '../../publish/application/review-dismiss.service'
import {
	ThreadReplyService,
	ThreadReplyServiceLive,
} from '../../publish/application/thread-reply.service'
import { isOpenBug, toBotThread } from '../../publish/domain/bot-thread.helper'
import type { SummaryMarker } from '../../publish/domain/publish-marker.schema'
import type { DismissalOutcome } from '../../publish/domain/publish.types'
import {
	getDuplicateSummaries,
	getListedWaiting,
	toSummaryComments,
} from '../../publish/domain/summary-comment.helper'
import {
	getPriorSummary,
	getStaleChangeRequests,
	toSummaryReviews,
} from '../../publish/domain/summary-review.helper'
import { toResolvers } from '../../publish/domain/thread-conversation.helper'
import { toClearedMessage } from '../../publish/presentation/summary-status.formatter'
import {
	type CommitStatusText,
	toChangedStatus,
	toHeldStatus,
	toIncompleteStatus,
	toSweptStanding,
} from '../domain/status.helper'

/** What a sweep did. */
export interface SweepResult {
	/** Open pull requests whose head carried the bot's `MNG Review` status. */
	readonly checked: number
	readonly updated: number
	/**
	 * Pull requests the sweep could not read or update, and those whose status it updated but whose
	 * head or reviews it could not read again before the dismissals.
	 */
	readonly failed: number
	/** The current identity's change requests dismissed on heads that stand `success`, and those that failed. */
	readonly dismissal: DismissalOutcome
}

/** What the sweep did on one pull request. */
interface SweptPull {
	/** `unknown` when it has no status of the bot. */
	readonly outcome: 'unknown' | 'kept' | 'updated' | 'failed'
	readonly dismissal: DismissalOutcome
	/** The status was updated, but a read before the dismissals failed: it counts as failed too. */
	readonly readFailed?: boolean
}

/**
 * The current identity's change requests when nothing open backs one (`unbacked`: no open bug
 * thread, no bug without a thread, nothing waiting), finished or not. With the marker on the head,
 * every one; with it on another head, which an unfinished full run leaves, only those on a known
 * commit other than `head`, the pull request's head: one whose commit is unknown is kept.
 */
function getUnbackedRequests(
	reviews: readonly PullRequestReview[],
	current: BotIdentity,
	head: string,
	marker: Pick<SummaryMarker, 'head'> | undefined,
	unbacked: boolean
): readonly number[] {
	if (!unbacked || !marker) return []
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
 * The ids of `ids` whose review a later read still shows with the body and state of the first
 * read: one edited in place meanwhile can carry new evidence, so it is not dismissed.
 */
function getUnchangedReviews(
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

/** Nothing dismissed. */
const NO_DISMISSAL = {
	dismissed: 0,
	failed: 0,
} as const satisfies DismissalOutcome

/**
 * Refreshes the `MNG Review` status of open pull requests whose head already carries one of an
 * owned identity, from the open bug threads of the owned identities now, so a thread resolved by
 * hand counts. It runs no model and posts no comment; pull requests the bot never reviewed are left
 * alone. It reads the status again right before it writes and leaves a newer one alone; a publish
 * run that lands between that read and the write can still be overwritten until the next sweep or
 * push. The summary is the newest summary review of an owned identity, or with none the old sticky
 * comment; while the current identity has more than one visible sticky comment and no review, the
 * status is left as it is but for the incomplete-read rule below. A thread a summary marker says
 * waits for the owner keeps the status `failure` until an admin or an allowed login resolves it;
 * the sweep never edits the summary. When no open bug thread, no bug without a thread on the
 * marker's head and nothing waiting remain, finished or not, it dismisses the current identity's
 * change requests it read before the threads, which a person resolving the last thread by hand
 * leaves stale: every one with the marker on the head, only those off the head with the marker on
 * another. With a change request to dismiss, it reads the reviews again before it decides the
 * status and skips a request that read shows edited or in another state. It dismisses only once its status write passed the freshness
 * check, or with no write due when the status still has the same writer and state, and only while
 * a read of the head right before the dismissal still shows the head it judged. A failed read on
 * the way counts the pull request as failed. While a list read of a pull request left a node out,
 * that second review read included, the sweep lifts no change request and clears no wait there,
 * and its status is never `success`: a `success` becomes `pending`.
 */
export class StatusSweepService extends Context.Service<
	StatusSweepService,
	{
		/** `allow` is `commands.allow` of the default branch, for who clears a waiting thread. */
		readonly sweep: (
			allow?: readonly string[]
		) => Effect.Effect<SweepResult, GitHubApiError, OwnedIdentities>
	}
>()('mng-review/StatusSweepService') {}

export const StatusSweepServiceLive = Layer.effect(
	StatusSweepService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const reviewsApi = yield* GitHubReviewService
		const github = yield* GitHubStatusService
		const conversation = yield* ThreadReplyService
		const dismissals = yield* ReviewDismissService

		/** Sets `next` unless a publish run set a newer status while the threads were read. */
		const writeStatus = Effect.fn('StatusSweepService.writeStatus')(function* (
			head: string,
			previousId: number,
			next: CommitStatusText
		) {
			const latest = yield* github.getStatus(head)
			if (latest?.id !== previousId) return 'kept' as const
			yield* github.setStatus({ sha: head, ...next })
			return 'updated' as const
		})

		/**
		 * True when the status still stands as the sweep read it: the same writer set the same state,
		 * so no publish run wrote between the sweep's reads and now.
		 */
		const isUnchanged = Effect.fn('StatusSweepService.isUnchanged')(function* (
			head: string,
			previous: CommitStatus
		) {
			const latest = yield* github.getStatus(head)
			return (
				latest?.state === previous.state &&
				latest.creator?.login === previous.creator?.login
			)
		})

		/**
		 * The status the threads stand for, held back from `success` while a list read of the pull
		 * request left a node out (`toIncompleteStatus`), since a thread it could not see may block;
		 * `undefined` when the head keeps the status it has.
		 */
		const toNextStatus = Effect.fn('StatusSweepService.toNextStatus')(
			function* (standing: CommitStatusText, previous: CommitStatus) {
				const lists = yield* getIncompleteLists
				return toChangedStatus(
					previous,
					lists.length > 0
						? toIncompleteStatus(standing, previous, lists)
						: standing
				)
			}
		)

		/**
		 * Leaves the head's status as it is, but never as `success` after a list read that left a node
		 * out (`toHeldStatus`); a failed write fails the pull request.
		 */
		const keepStatus = Effect.fn('StatusSweepService.keepStatus')(function* (
			head: string,
			previous: CommitStatus
		) {
			const held = toHeldStatus(previous, yield* getIncompleteLists)
			if (!held) return 'kept' as const
			return yield* writeStatus(head, previous.id, held).pipe(
				Effect.orElseSucceed(() => 'failed' as const)
			)
		})

		/** One pull request: `unknown` when it has no status of the bot, else whether it changed. */
		const sweepOne = Effect.fn('StatusSweepService.sweepOne')(function* (
			pullNumber: number,
			head: string,
			allow: readonly string[]
		) {
			const previous = yield* github.getStatus(head)
			if (!previous)
				return {
					outcome: 'unknown',
					dismissal: NO_DISMISSAL,
				} satisfies SweptPull
			const { current, identities } = yield* OwnedIdentities
			// Reviews first: a change request posted after this read is never dismissed by this sweep.
			const reviews = yield* reviewsApi.listReviews(pullNumber, true)
			const comments = yield* api.listComments(pullNumber)
			const raw = yield* api.listReviewThreads(pullNumber)
			const threads = raw.flatMap(
				thread => toBotThread(thread, identities) ?? []
			)
			// Reads only: a resolved bug with an unsettled answer counts open, read whole when unknown.
			const openBugs = (yield* conversation.resolveUnsettled(
				threads,
				raw
			)).filter(isOpenBug).length
			const summaryReviews = toSummaryReviews(reviews, identities, current)
			const summaries = toSummaryComments(comments, identities, current)
			// With two old sticky comments of the current identity, the oldest may be a stale finished one.
			if (
				summaryReviews.length === 0 &&
				getDuplicateSummaries(summaries).length > 0
			)
				return {
					outcome: yield* keepStatus(head, previous),
					dismissal: NO_DISMISSAL,
				} satisfies SweptPull
			const summary = getPriorSummary(summaryReviews, summaries)
			const marker = summary?.marker
			const onHead = marker?.head === head
			// Bugs runs on this head left without a thread still block it until a full review replaces them.
			const unthreaded = onHead ? (marker?.unthreadedBugs ?? 0) : 0
			// A marker's finished flag is its head's: a partial run on another head keeps it. A previous
			// identity's marker stopped at the switch, so off its head the status already set decides.
			const finished =
				summary?.mine || onHead ? marker?.finished && onHead : undefined
			// Hidden summaries still list, and threads the bot sent to the owner still wait, edited or resolved.
			const waiting = [
				...new Set([
					...getListedWaiting([...reviews, ...comments], identities),
					...(yield* conversation.getSentToOwner(raw)),
				]),
			]
			const cleared = yield* conversation.getCleared({
				waiting,
				resolvers: toResolvers(raw),
				threads: raw,
				allow,
			})
			const owner = waiting.filter(id => !cleared.has(id)).length
			// A list read that left a node out may miss an open thread, so no request is stale.
			const stale = (yield* isReadIncomplete)
				? []
				: getUnbackedRequests(
						reviews,
						current,
						head,
						marker,
						openBugs + unthreaded + owner === 0
					)
			// The reviews again before the status, so a node this last list read leaves out holds back
			// `success` as well as the dismissals; a failed read dismisses nothing and fails.
			const unchanged = yield* Effect.result(
				stale.length === 0
					? Effect.succeed([])
					: reviewsApi
							.listReviews(pullNumber, true)
							.pipe(
								Effect.map(latest =>
									getUnchangedReviews(stale, reviews, latest)
								)
							)
			)
			// The head again right before dismissing: a push since the listing keeps every request.
			const dismiss = Effect.fn('StatusSweepService.dismiss')(function* () {
				if (stale.length === 0) return NO_DISMISSAL
				const pr = yield* api.getPullRequest(pullNumber)
				if (pr.head.sha !== head) return NO_DISMISSAL
				if (Result.isFailure(unchanged)) return yield* unchanged.failure
				// `liftRequests` dismisses none once the confirming read, or any before it, left a node out.
				return yield* dismissals.liftRequests(
					pullNumber,
					unchanged.success,
					toClearedMessage(head)
				)
			})
			const next = yield* toNextStatus(
				toSweptStanding(previous, openBugs + unthreaded, finished, owner),
				previous
			)
			if (!next) {
				// A failed read fails the pull request, as a failed status write does.
				const standing =
					stale.length > 0 && (yield* isUnchanged(head, previous))
				const dismissal = standing ? yield* dismiss() : NO_DISMISSAL
				return { outcome: 'kept', dismissal } satisfies SweptPull
			}
			const outcome = yield* writeStatus(head, previous.id, next).pipe(
				Effect.orElseSucceed(() => 'failed' as const)
			)
			if (outcome !== 'updated')
				return { outcome, dismissal: NO_DISMISSAL } satisfies SweptPull
			// Only once the freshness check passed and the status was written, which a failed read keeps.
			return yield* dismiss().pipe(
				Effect.map((dismissal): SweptPull => ({ outcome, dismissal })),
				Effect.orElseSucceed((): SweptPull => ({
					outcome,
					dismissal: NO_DISMISSAL,
					readFailed: true,
				}))
			)
		})

		const sweep = Effect.fn('StatusSweepService.sweep')(function* (
			allow: readonly string[] = []
		) {
			const pulls = yield* github.listOpenPullRequests()
			const swept = yield* Effect.forEach(
				pulls,
				pull =>
					sweepOne(pull.number, pull.head.sha, allow).pipe(
						restartListCount,
						Effect.orElseSucceed((): SweptPull => ({
							outcome: 'failed',
							dismissal: NO_DISMISSAL,
						}))
					),
				{ concurrency: 1 }
			)
			const outcomes = swept.map(pull => pull.outcome)
			return {
				checked: outcomes.filter(outcome => outcome !== 'unknown').length,
				updated: outcomes.filter(outcome => outcome === 'updated').length,
				failed: swept.filter(
					pull => pull.outcome === 'failed' || pull.readFailed === true
				).length,
				dismissal: {
					dismissed: swept.reduce(
						(sum, pull) => sum + pull.dismissal.dismissed,
						0
					),
					failed: swept.reduce((sum, pull) => sum + pull.dismissal.failed, 0),
				},
			} satisfies SweepResult
		})

		return { sweep }
	})
).pipe(
	Layer.provide(
		Layer.mergeAll(ThreadReplyServiceLive, ReviewDismissServiceLive)
	)
)
