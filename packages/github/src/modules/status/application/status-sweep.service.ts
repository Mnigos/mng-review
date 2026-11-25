import { Context, Effect, Layer } from 'effect'
import type { CommitStatus } from '../../../platform/github-api.schema'
import { GitHubReviewService } from '../../../platform/github-review.service'
import { GitHubStatusService } from '../../../platform/github-status.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import {
	getIncompleteLists,
	restartListCount,
} from '../../../platform/list-completeness.context'
import type { OwnedIdentities } from '../../../platform/owned-identities.context'
import { ThreadReplyServiceLive } from '../../publish/application/thread-reply.service'
import type {
	IncompletePull,
	SweptJudgment,
	SweptPull,
} from '../domain/status-sweep.types'
import {
	type CommitStatusText,
	toHeldStatus,
	toLoweredStatus,
	toNextSweptStatus,
	toSweptStanding,
} from '../domain/status.helper'
import { PullStateService, PullStateServiceLive } from './pull-state.service'

/** What a sweep did. */
export interface SweepResult {
	/** Open pull requests whose head carried the bot's `MNG Review` status. */
	readonly checked: number
	readonly updated: number
	/** Pull requests the sweep could not read or update. */
	readonly failed: number
	/** The pull requests whose list reads left an entry out, and which lists; unset when none did. */
	readonly incomplete?: readonly IncompletePull[]
}

/**
 * Lowers the `MNG Review` status of open pull requests whose head already carries one of an owned
 * identity, from the open bug threads of the owned identities now: a bug a run reopened, a wait it
 * recorded, an unfinished run or a list read that left a node out. It runs no model, posts no
 * comment, dismisses no review and never writes `success`: every raise holds the pull request's
 * publish group, and between runs only the reply schedule's raise job (`RaiseService`) raises.
 * Pull requests the bot never reviewed are left alone. What it reads and judges is
 * `PullStateService.read`, one pass with no write; it writes the plan (`toNextSweptStatus`) only
 * when that blocks more than the status (`toLoweredStatus`), so it never writes an `error` over a
 * `failure` and leaves a status that blocks as much alone. While the current identity has more than
 * one visible sticky comment and no review, the status is left as it is but for the incomplete-read
 * rule. A thread a summary marker says waits for the owner keeps the status `failure` until an
 * admin or an allowed login resolves it; the sweep never edits the summary. While a list read of a
 * pull request left a node out, a `success` becomes `INCOMPLETE_STATUS`, and the result names the
 * lists (`incomplete`); a summary marker an incomplete write left (`isIncompleteMarker`) never
 * lowers a `failure` (`toIncompleteMarkerStatus`). The status write reads the status again right
 * before it writes and skips the write when that read already sees another status; GitHub takes no
 * expected status, so a status posted after that read can still be followed by the sweep's
 * lowering. A failed read or write counts the pull request as failed.
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
			const judged = yield* judge(pullNumber, head, allow)
			if (!judged) return { outcome: 'unknown' } satisfies SweptPull
			const { previous } = judged
			if (judged.kind === 'duplicate')
				return {
					outcome: yield* keepStatus(head, previous),
				} satisfies SweptPull
			// Only a plan that blocks more than the status is written: a raise needs the publish group.
			const next = toLoweredStatus(
				[
					toNextSweptStatus(
						judged.standing,
						previous,
						judged.unfinished,
						yield* getIncompleteLists
					),
				],
				previous
			)
			if (!next) return { outcome: 'kept' } satisfies SweptPull
			const outcome = yield* writeStatus(head, previous.id, next).pipe(
				Effect.orElseSucceed(() => 'failed' as const)
			)
			return { outcome } satisfies SweptPull
		})

		const sweep = Effect.fn('StatusSweepService.sweep')(function* (
			allow: readonly string[] = []
		) {
			const open = yield* github.listOpenPullRequests()
			const swept = yield* Effect.forEach(
				open,
				pull =>
					Effect.gen(function* () {
						// A failed read still reports the lists the reads before it left a node out of.
						const result: SweptPull = yield* sweepOne(
							pull.number,
							pull.head.sha,
							allow
						).pipe(
							Effect.orElseSucceed((): SweptPull => ({ outcome: 'failed' }))
						)
						const lists = yield* getIncompleteLists
						return lists.length > 0 ? { ...result, lists } : result
					}).pipe(restartListCount),
				{ concurrency: 1 }
			)
			const outcomes = swept.map(pull => pull.outcome)
			const incomplete = open.flatMap((pull, index): IncompletePull[] => {
				const lists = swept[index]?.lists
				return lists ? [{ pullNumber: pull.number, lists }] : []
			})
			return {
				checked: outcomes.filter(outcome => outcome !== 'unknown').length,
				updated: outcomes.filter(outcome => outcome === 'updated').length,
				failed: outcomes.filter(outcome => outcome === 'failed').length,
				...(incomplete.length > 0 ? { incomplete } : {}),
			} satisfies SweepResult
		})

		return { sweep }
	})
).pipe(
	Layer.provide(PullStateServiceLive),
	Layer.provide(ThreadReplyServiceLive)
)
