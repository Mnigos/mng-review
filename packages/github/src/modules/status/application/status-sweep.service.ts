import { Context, Effect, Layer, Result } from 'effect'
import type { CommitStatus } from '../../../platform/github-api.schema'
import { GitHubReviewService } from '../../../platform/github-review.service'
import { GitHubStatusService } from '../../../platform/github-status.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import {
	getIncompleteLists,
	isReadIncomplete,
	restartListCount,
} from '../../../platform/list-completeness.context'
import type { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	isSameReads,
	withReadJournal,
} from '../../../platform/read-journal.context'
import { ReadJournalLayer } from '../../../platform/read-journal.layer'
import { ThreadReplyServiceLive } from '../../publish/application/thread-reply.service'
import type { SweptJudgment, SweptPull } from '../domain/status-sweep.types'
import {
	type CommitStatusText,
	toHeldStatus,
	toLoweredStatus,
	toNextSweptStatus,
	toSweptStanding,
	UNCONFIRMED_STATUS,
} from '../domain/status.helper'
import { PullStateService, PullStateServiceLive } from './pull-state.service'

/** What a sweep did. */
export interface SweepResult {
	/** Open pull requests whose head carried the bot's `MNG Review` status. */
	readonly checked: number
	readonly updated: number
	/**
	 * Pull requests the sweep could not read or update, and those it could not read again before it
	 * raised.
	 */
	readonly failed: number
}

/**
 * Refreshes the `MNG Review` status of open pull requests whose head already carries one of an
 * owned identity, from the open bug threads of the owned identities now, so a thread resolved by
 * hand counts. It runs no model, posts no comment and dismisses no review: the reply schedule lifts
 * a change request nothing backs any more, in a job that holds the pull request's publish group
 * (`RequestLiftService`). Pull requests the bot never reviewed are left alone. What it reads and
 * judges is `PullStateService.read`: while the current identity has more than one visible sticky
 * comment and no review, the status is left as it is but for the incomplete-read rule below. A
 * thread a summary marker says waits for the owner keeps the status `failure` until an admin or an
 * allowed login resolves it; the sweep never edits the summary.
 *
 * Lowering the status needs nothing more. Writing `success` stands only on a second pass that
 * makes every read of the first again and gets the same answers (`isSameReads`): the status, the
 * reviews, the conversation comments, the review threads, each thread read whole and each
 * resolver's collaborator role. The read journal (`ReadJournalLayer`) records every GitHub read
 * below the sweep, so nothing the decision reads is left out of the comparison; only what the
 * sweep reads once for all pull requests stays outside: the open pull requests and their heads,
 * `commands.allow` and the owned identities. A second pass that fails, or that left a node out,
 * counts as a change. When something changed, a run or a person wrote meanwhile: a run writes its
 * own status, and the next sweep settles the rest, so steady activity on a pull request defers a
 * `success` until it quiets down while the blocking status stays. Such a second pass, a failed one
 * or one that left a node out, only lowers the status (`toLoweredStatus`): of both passes' plans it
 * writes the most blocking one that blocks more than the status, a failed one also turns a
 * `success` into `pending` (`UNCONFIRMED_STATUS`), and it lifts nothing. The status write still
 * checks right before it writes that the status is the one the sweep read, so a writer that lands
 * after the second read can still be overwritten with a `success`; the next sweep, or that
 * writer's own next status, repairs it. A failed read on the way counts the pull request as failed.
 * While a list read of a pull request left a node out, its status is never `success`: a `success`
 * becomes `pending`. A summary marker an incomplete write left (`isIncompleteMarker`) holds the same
 * way until a full run that finished replaces it: the status is never `success` and a `failure` is
 * never lowered (`toIncompleteMarkerStatus`).
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
		const reviewsApi = yield* GitHubReviewService
		const github = yield* GitHubStatusService
		const pulls = yield* PullStateService

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
			const reviews = yield* reviewsApi.listReviews(pullNumber, true)
			const state = yield* pulls.read({ pullNumber, head, reviews, allow })
			if (state.kind === 'duplicate')
				return { kind: 'duplicate', previous } satisfies SweptJudgment
			return {
				kind: 'judged',
				previous,
				standing: toSweptStanding(
					previous,
					state.bugs,
					state.finished,
					state.uncleared
				),
				unfinished: state.unfinished,
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
			if (!judged) return { outcome: 'unknown' } satisfies SweptPull
			const { previous } = judged
			if (judged.kind === 'duplicate')
				return {
					outcome: yield* keepStatus(head, previous),
				} satisfies SweptPull
			const { standing, unfinished } = judged
			const toNext = Effect.fn('StatusSweepService.toNext')(function* () {
				return toNextSweptStatus(
					standing,
					previous,
					unfinished,
					yield* getIncompleteLists
				)
			})
			const planned = yield* toNext()
			const due = planned?.state === 'success'
			// A `success` stands only on a second pass that reads exactly what the first read: a run that
			// wrote meanwhile writes its own status, and the next sweep settles the rest.
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
			if (!next) return { outcome: 'kept', readFailed } satisfies SweptPull
			const outcome = yield* writeStatus(head, previous.id, next).pipe(
				Effect.orElseSucceed(() => 'failed' as const)
			)
			return { outcome, readFailed } satisfies SweptPull
		})

		const sweep = Effect.fn('StatusSweepService.sweep')(function* (
			allow: readonly string[] = []
		) {
			const open = yield* github.listOpenPullRequests()
			const swept = yield* Effect.forEach(
				open,
				pull =>
					sweepOne(pull.number, pull.head.sha, allow).pipe(
						restartListCount,
						Effect.orElseSucceed((): SweptPull => ({ outcome: 'failed' }))
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
			} satisfies SweepResult
		})

		return { sweep }
	})
).pipe(
	// Fresh, so a build that shares these layers elsewhere never hands the sweep one whose reads
	// bypass its read journal.
	Layer.provide(Layer.fresh(PullStateServiceLive)),
	Layer.provide(Layer.fresh(ThreadReplyServiceLive)),
	// Every read below the sweep, the thread service's included, goes into the open read journal.
	Layer.provide(ReadJournalLayer)
)
