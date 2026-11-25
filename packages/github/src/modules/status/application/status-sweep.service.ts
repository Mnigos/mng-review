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
	isSameReads,
	withReadJournal,
} from '../../../platform/read-journal.context'
import { ReadJournalLayer } from '../../../platform/read-journal.layer'
import {
	ReviewDismissService,
	ReviewDismissServiceLive,
} from '../../publish/application/review-dismiss.service'
import {
	ThreadReplyService,
	ThreadReplyServiceLive,
} from '../../publish/application/thread-reply.service'
import { isOpenBug, toBotThread } from '../../publish/domain/bot-thread.helper'
import type { DismissalOutcome } from '../../publish/domain/publish.types'
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
import type { SweptJudgment, SweptPull } from '../domain/status-sweep.types'
import {
	type CommitStatusText,
	toHeldStatus,
	toLoweredStatus,
	toNextSweptStatus,
	toSweptStanding,
	UNCONFIRMED_STATUS,
} from '../domain/status.helper'
import {
	getSweptFinished,
	getUnbackedRequests,
	getUnthreadedBugs,
	isConfirmDue,
} from '../domain/sweep-review.helper'

/** What a sweep did. */
export interface SweepResult {
	/** Open pull requests whose head carried the bot's `MNG Review` status. */
	readonly checked: number
	readonly updated: number
	/**
	 * Pull requests the sweep could not read or update, those it could not read again before it
	 * raised, and those whose status it updated but whose head it could not read again.
	 */
	readonly failed: number
	/** The current identity's change requests dismissed on heads that stand `success`, and those that failed. */
	readonly dismissal: DismissalOutcome
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
 * alone. The summary is the newest summary review of an owned identity, or with none the old sticky
 * comment; while the current identity has more than one visible sticky comment and no review, the
 * status is left as it is but for the incomplete-read rule below. A thread a summary marker says
 * waits for the owner keeps the status `failure` until an admin or an allowed login resolves it;
 * the sweep never edits the summary. When no open bug thread, no bug without a thread on the
 * marker's head and nothing waiting remain, finished or not, the current identity's change requests
 * it read before the threads are stale, which a person resolving the last thread by hand leaves:
 * every one with the marker on the head, only those off the head with the marker on another.
 *
 * Lowering the status needs nothing more. Raising it, by writing `success` or dismissing a stale
 * change request, stands only on a second pass that makes every read of the first again and gets
 * the same answers (`isSameReads`): the status, the reviews, the conversation comments, the review
 * threads, each thread read whole and each resolver's collaborator role. The read journal
 * (`ReadJournalLayer`) records every GitHub read below the sweep, so nothing the decision reads is
 * left out of the comparison; only what the sweep reads once for all pull requests stays outside:
 * the open pull requests and their heads, `commands.allow` and the owned identities. A second pass
 * that fails, or that left a node out, counts as a change. When something changed, a run or a
 * person wrote meanwhile: a run writes its own status, and the next sweep settles the rest, so
 * steady activity on a pull request defers a raise until it quiets down while the blocking status
 * stays. Such a second pass, a failed one or one that left a node out, only lowers the status
 * (`toLoweredStatus`): of both passes' plans it writes the most blocking one that blocks more than
 * the status, a failed one also turns a `success` into `pending` (`UNCONFIRMED_STATUS`), and it
 * lifts nothing. The
 * status write still checks right before it writes that the status is the one the sweep read, so a
 * run that lands after the second read can still be overwritten until the next sweep or push. A
 * dismissal waits for that write, or with no write due reads the status once more and goes ahead
 * only while it is still the one the sweep read; either way only while a read of the head right
 * before it still shows the head the sweep judged. A failed read on the way counts the pull
 * request as failed.
 * While a list read of a pull request left a node out, its status is never `success`: a `success`
 * becomes `pending`. A summary marker an incomplete write left (`isIncompleteMarker`) holds the same
 * way until a full run that finished replaces it: the status is never `success`, a `failure` is
 * never lowered (`toIncompleteMarkerStatus`) and no change request is lifted.
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

		/**
		 * One pass over a pull request: every read its decision makes, then that decision, with no
		 * write. `undefined` when the head has no status of the bot.
		 */
		const judge = Effect.fn('StatusSweepService.judge')(function* (
			pullNumber: number,
			head: string,
			allow: readonly string[]
		) {
			const previous = yield* github.getStatus(head)
			if (!previous) return undefined
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
				return { kind: 'duplicate', previous } satisfies SweptJudgment
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
			const bugs = openBugs + getUnthreadedBugs(marker, head)
			const unfinished = isIncompleteMarker(marker)
			return {
				kind: 'judged',
				previous,
				// A list read that left a node out may miss an open thread, so no request is stale.
				stale: (yield* isReadIncomplete)
					? []
					: getUnbackedRequests(
							reviews,
							current,
							head,
							marker,
							bugs + uncleared.length === 0
						),
				standing: toSweptStanding(
					previous,
					bugs,
					!unfinished && getSweptFinished(summary, head),
					uncleared.length
				),
				unfinished,
			} satisfies SweptJudgment
		})

		/** One pull request: `unknown` when it has no status of the bot, else whether it changed. */
		const sweepOne = Effect.fn('StatusSweepService.sweepOne')(function* (
			pullNumber: number,
			head: string,
			allow: readonly string[]
		) {
			const first = yield* withReadJournal(judge(pullNumber, head, allow))
			const judged = first.value
			if (!judged)
				return {
					outcome: 'unknown',
					dismissal: NO_DISMISSAL,
				} satisfies SweptPull
			const { previous } = judged
			if (judged.kind === 'duplicate')
				return {
					outcome: yield* keepStatus(head, previous),
					dismissal: NO_DISMISSAL,
				} satisfies SweptPull
			const { stale, standing, unfinished } = judged
			const toNext = Effect.fn('StatusSweepService.toNext')(function* () {
				return toNextSweptStatus(
					standing,
					previous,
					unfinished,
					yield* getIncompleteLists
				)
			})
			const planned = yield* toNext()
			const due = isConfirmDue(stale, planned)
			// A `success` or a dismissal stands only on a second pass that reads exactly what the first
			// read: a run that wrote meanwhile writes its own status, and the next sweep settles the rest.
			const confirming = yield* Effect.result(
				due
					? withReadJournal(judge(pullNumber, head, allow))
					: Effect.succeed(undefined)
			)
			// A failed second read raises nothing and counts whatever the status write does next.
			const readFailed = Result.isFailure(confirming)
			const second = Result.getOrUndefined(confirming)
			// A node the second read, or any before it, left out counts as a change.
			const settled =
				second !== undefined &&
				!(yield* isReadIncomplete) &&
				isSameReads(first.reads, second.reads)
			// A node the second read left out holds a `success` back as one the first reads left out does.
			const held = yield* toNext()
			// Passes that differ, or a second pass that failed or left a node out, only lower: from either
			// pass's plan, the most blocking one that blocks more than the status, so neither plan's
			// holds (an unfinished marker's included) can be bypassed and nothing is raised.
			const recheck = second?.value
			const next =
				!due || settled
					? held
					: toLoweredStatus(
							[
								held,
								recheck?.kind === 'judged'
									? toNextSweptStatus(
											recheck.standing,
											recheck.previous,
											recheck.unfinished,
											yield* getIncompleteLists
										)
									: undefined,
								// A failed second pass holds a `success` back as one that left a node out does.
								readFailed && previous.state === 'success'
									? UNCONFIRMED_STATUS
									: undefined,
							],
							previous
						)
			const lifted = settled ? stale : []
			// The head again right before dismissing: a push since the listing keeps every request.
			const dismiss = Effect.fn('StatusSweepService.dismiss')(function* (
				written: boolean
			) {
				if (lifted.length === 0) return NO_DISMISSAL
				const pr = yield* api.getPullRequest(pullNumber)
				if (pr.head.sha !== head) return NO_DISMISSAL
				// With no write of its own, the status again: a run that wrote one since keeps every request.
				if (!written && (yield* github.getStatus(head))?.id !== previous.id)
					return NO_DISMISSAL
				// `liftRequests` dismisses none once the second read, or any before it, left a node out.
				return yield* dismissals.liftRequests(
					pullNumber,
					lifted,
					toClearedMessage(head)
				)
			})
			if (!next)
				return {
					outcome: 'kept',
					dismissal: yield* dismiss(false),
					readFailed,
				} satisfies SweptPull
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
			return yield* dismiss(true).pipe(
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
	// Fresh, so a build that shares these layers elsewhere never hands the sweep one whose reads
	// bypass its read journal.
	Layer.provide(
		Layer.mergeAll(
			Layer.fresh(ThreadReplyServiceLive),
			Layer.fresh(ReviewDismissServiceLive)
		)
	),
	// Every read below the sweep, the thread service's included, goes into the open read journal.
	Layer.provide(ReadJournalLayer)
)
