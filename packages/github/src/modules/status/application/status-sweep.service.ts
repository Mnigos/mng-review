import { Context, Effect, Layer, Result } from 'effect'
import type { CommitStatus } from '../../../platform/github-api.schema'
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
import type {
	DismissalOutcome,
	SummaryComment,
} from '../../publish/domain/publish.types'
import {
	getDuplicateSummaries,
	getListedWaiting,
	toSummaryComments,
} from '../../publish/domain/summary-comment.helper'
import { isIncompleteMarker } from '../../publish/domain/summary-marker.helper'
import {
	getPriorSummary,
	toSummaryReviews,
} from '../../publish/domain/summary-review.helper'
import { toResolvers } from '../../publish/domain/thread-conversation.helper'
import { toClearedMessage } from '../../publish/presentation/summary-status.formatter'
import {
	type CommitStatusText,
	toHeldStatus,
	toNextSweptStatus,
	toSweptStanding,
} from '../domain/status.helper'
import {
	getConfirmedSummary,
	getConfirmedWaiting,
	getSweptFinished,
	getUnbackedRequests,
	getUnchangedReviews,
	getUnthreadedBugs,
	isConfirmDue,
	isPlanTurned,
	isSweptUnfinished,
	toConfirmedStatus,
} from '../domain/sweep-review.helper'

/** What a sweep did. */
export interface SweepResult {
	/** Open pull requests whose head carried the bot's `MNG Review` status. */
	readonly checked: number
	readonly updated: number
	/**
	 * Pull requests the sweep could not read or update, those whose reviews it could not read again
	 * before the dismissals, and those whose status it updated but whose head it could not read again.
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
	/**
	 * A read before the dismissals failed: the confirming review read, whatever the status write
	 * did, or the head read after a status update. It counts as failed too.
	 */
	readonly readFailed?: boolean
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
 * another. With a change request to dismiss, or a `success` to write, it reads the reviews again
 * before it decides the status and skips a request that read shows edited or in another state; a
 * `success` stands only on that read, so a failed one, or one whose newest summary marker an
 * incomplete write left, writes none. It dismisses only once its status write passed the freshness
 * check, or with no write due when the status still has the same writer and state, and only while
 * a read of the head right before the dismissal still shows the head it judged. A failed read on
 * the way counts the pull request as failed. While a list read of a pull request left a node out,
 * that second review read included, the sweep lifts no change request and clears no wait there,
 * and its status is never `success`: a `success` becomes `pending`. A summary marker an incomplete
 * write left (`isIncompleteMarker`) holds the same way until a full run that finished replaces
 * it: the status is never `success`, a `failure` is never lowered (`toIncompleteMarkerStatus`) and
 * no change request is lifted. That holds too when such a marker is newest only in the confirming
 * review read, written by a run that landed between the sweep's two review reads. The status and
 * the requests it lifts are decided again from that read's newest summary, so one posted there that
 * holds a bug without a thread or a wait, or turns a planned `success` aside, writes no `success` and
 * lifts none. That decision can only hold back a planned `success`, never raise a plan to one.
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
			const uncleared = waiting.filter(id => !cleared.has(id))
			// A list read that left a node out may miss an open thread, so no request is stale.
			const incomplete = yield* isReadIncomplete
			const toUnbacked = (judged: SummaryComment | undefined, waits: number) =>
				incomplete
					? []
					: getUnbackedRequests(
							reviews,
							current,
							head,
							judged?.marker,
							openBugs + getUnthreadedBugs(judged?.marker, head) + waits === 0
						)
			const stale = toUnbacked(summary, uncleared.length)
			const toNext = Effect.fn('StatusSweepService.toNext')(function* (
				judged: SummaryComment | undefined,
				unfinished: boolean,
				waits: number
			) {
				return toNextSweptStatus(
					toSweptStanding(
						previous,
						openBugs + getUnthreadedBugs(judged?.marker, head),
						!unfinished && getSweptFinished(judged, head),
						waits
					),
					previous,
					unfinished,
					yield* getIncompleteLists
				)
			})
			const planned = yield* toNext(
				summary,
				isIncompleteMarker(marker),
				uncleared.length
			)
			// The reviews again before a dismissal or a `success`, so a node this last list read leaves
			// out holds both back; a failed read dismisses nothing, writes no `success` and fails.
			const confirming = yield* Effect.result(
				isConfirmDue(stale, planned)
					? reviewsApi.listReviews(pullNumber, true)
					: Effect.succeed(undefined)
			)
			// A failed confirming read dismisses nothing and counts whatever the status write does next.
			const readFailed = Result.isFailure(confirming)
			const latest = Result.getOrUndefined(confirming)
			// A run that landed between the two review reads may have left a newer summary to decide from.
			const swept = { summary, latest, summaries, owned: identities, current }
			const confirmed = getConfirmedSummary(swept)
			const unfinished = isSweptUnfinished(swept)
			// A wait in either read holds; one only the confirming read lists is never cleared.
			const waits = new Set([
				...uncleared,
				...getConfirmedWaiting(summary, confirmed),
			]).size
			const recomputed = yield* toNext(confirmed, unfinished, waits)
			// The confirming read only lowers the plan: a `success` stands on a planned one and that read.
			const next = toConfirmedStatus(planned, recomputed, readFailed)
			// A newer summary that backs a request, or turns the plan aside, lifts none.
			const backed = toUnbacked(confirmed, waits)
			const unchanged =
				unfinished || isPlanTurned(planned, recomputed)
					? []
					: getUnchangedReviews(
							stale.filter(id => backed.includes(id)),
							reviews,
							latest ?? []
						)
			// The head again right before dismissing: a push since the listing keeps every request.
			const dismiss = Effect.fn('StatusSweepService.dismiss')(function* () {
				if (unchanged.length === 0) return NO_DISMISSAL
				const pr = yield* api.getPullRequest(pullNumber)
				if (pr.head.sha !== head) return NO_DISMISSAL
				// `liftRequests` dismisses none once the confirming read, or any before it, left a node out.
				return yield* dismissals.liftRequests(
					pullNumber,
					unchanged,
					toClearedMessage(head)
				)
			})
			if (!next) {
				// A failed read fails the pull request, as a failed status write does.
				const standing =
					stale.length > 0 && (yield* isUnchanged(head, previous))
				const dismissal = standing ? yield* dismiss() : NO_DISMISSAL
				return { outcome: 'kept', dismissal, readFailed } satisfies SweptPull
			}
			const outcome = yield* writeStatus(head, previous.id, next).pipe(
				Effect.orElseSucceed(() => 'failed' as const)
			)
			if (outcome !== 'updated')
				return {
					outcome,
					dismissal: NO_DISMISSAL,
					readFailed,
				} satisfies SweptPull
			// Only once the freshness check passed and the status was written, which a failed read keeps.
			return yield* dismiss().pipe(
				Effect.map((dismissal): SweptPull => ({
					outcome,
					dismissal,
					readFailed,
				})),
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
