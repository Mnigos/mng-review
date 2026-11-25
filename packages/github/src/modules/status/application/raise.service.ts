import { Clock, Context, Duration, Effect, Layer, Ref, Result } from 'effect'
import type { OpenPullRequest } from '../../../platform/github-api.schema'
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
import { ThreadReplyServiceLive } from '../../publish/application/thread-reply.service'
import { getStaleChangeRequests } from '../../publish/domain/summary-review.helper'
import { toClearedMessage } from '../../publish/presentation/summary-status.formatter'
import { getScanStride } from '../domain/raise-scan.helper'
import {
	toLoweredStatus,
	toNextSweptStatus,
	toSweptStanding,
} from '../domain/status.helper'
import { PullStateService, PullStateServiceLive } from './pull-state.service'
import {
	CLEARING,
	getWriteOutcome,
	isDue,
	NO_DISMISSAL,
} from './raise.service.helper'
import type {
	LiftResult,
	RaiseFindResult,
	RaiseJudgment,
	RaiseOutcome,
	RaiseResult,
	RaiseScan,
	ScanTally,
	StatusWrite,
} from './raise.service.types'

/**
 * Between runs the only place that raises: it writes the bot's `success` and lifts the current
 * identity's change requests inside the pull request's publish group (`mng-review-publish-<number>`),
 * which runs also hold for their own raises, so no publishing run writes threads, a summary or a
 * status between its judgment and its writes. A raise
 * is due once nothing blocks, which a person resolving the last thread by hand leaves: no open bug
 * thread, no bug without a thread in the newest marker's `unthreadedBugs` (on any head for a change
 * request; only a later marker that no longer lists them clears them), nothing waiting for the owner
 * and no summary an incomplete run left, with every list read complete (`PullStateService.read`).
 * The status follows the sweep's rules (`toNextSweptStatus`): `success` only on a finished run on the
 * head. From a complete read it also writes a changed blocking plan, such as `error` over a
 * `failure` once a cleared wait leaves an unfinished run, or a new bug count; under a marker an
 * incomplete run left only a plan that blocks more (`toLoweredStatus`).
 *
 * Only the reply schedule runs it. `findDue`, in the find job with a read-only token, lists a pull
 * request only when its plan differs from its status or a change request would be lifted. `raise`
 * judges one of them again, from one fresh read, in the job that holds the group, reads the pull
 * request and the status again right before its writes and writes nothing when it closed or either
 * changed; only a write that landed counts as a raise. A person can
 * still reopen a thread after the judgment read the review threads and before the writes; the next
 * sweep lowers the status again, and nothing restores a change request once dismissed.
 */
export class RaiseService extends Context.Service<
	RaiseService,
	{
		/**
		 * The open pull requests with a raise due; one whose read fails is skipped and counted. The
		 * scan starts `scan.rotation` strides into the list and starts no judgment past `scan.deadline`,
		 * keeping what it judged; `scan.bound` ends it, its listing included (`stop: 'bound'`).
		 */
		readonly findDue: (
			allow: readonly string[],
			scan?: RaiseScan
		) => Effect.Effect<RaiseFindResult, GitHubApiError, OwnedIdentities>
		/**
		 * Reads the pull request and judges it again; while a raise is still due, the pull request open
		 * and the head and the status the ones it judged, writes the status and then dismisses the
		 * change requests it judged stale (`ReviewDismissService.liftRequests`).
		 */
		readonly raise: (
			pullNumber: number,
			allow: readonly string[]
		) => Effect.Effect<RaiseResult, GitHubApiError, OwnedIdentities>
	}
>()('mng-review/RaiseService') {}

export const RaiseServiceLive = Layer.effect(
	RaiseService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const reviewsApi = yield* GitHubReviewService
		const github = yield* GitHubStatusService
		const pulls = yield* PullStateService
		const dismissals = yield* ReviewDismissService

		/** What to write on `head`; nothing when nothing would change. */
		const judge = Effect.fn('RaiseService.judge')(function* (
			pullNumber: number,
			head: string,
			allow: readonly string[]
		) {
			const { current } = yield* OwnedIdentities
			const previous = yield* github.getStatus(head)
			// Reviews before the threads: a change request posted after this read is never lifted.
			const reviews = yield* reviewsApi.listReviews(pullNumber, true)
			const requested =
				getStaleChangeRequests(reviews, [current], current, CLEARING).length > 0
			// With no change request and no status to turn green, nothing else is read.
			if (!requested && (!previous || previous.state === 'success'))
				return { stale: [] } satisfies RaiseJudgment
			const state = yield* pulls.read({ pullNumber, head, reviews, allow })
			if (state.kind === 'duplicate')
				return { stale: [], full: true } satisfies RaiseJudgment
			if (!previous)
				return { stale: state.stale, full: true } satisfies RaiseJudgment
			const planned = toNextSweptStatus(
				toSweptStanding(previous, state.bugs, state.finished, state.uncleared),
				previous,
				state.unfinished,
				yield* getIncompleteLists
			)
			// Under the group a complete read writes any plan that changed the status; a marker an
			// incomplete run left may miss what set it, so then only one that blocks more.
			const status = state.unfinished
				? toLoweredStatus([planned], previous)
				: planned
			return {
				previous,
				...(status ? { status } : {}),
				stale: state.stale,
				full: true,
			} satisfies RaiseJudgment
		})

		const findDue = Effect.fn('RaiseService.findDue')(function* (
			allow: readonly string[],
			scan?: RaiseScan
		) {
			const deadline = scan?.deadline
			const limit = scan?.limit
			const tally = yield* Ref.make<ScanTally>({
				due: [],
				read: 0,
				failed: 0,
				scanned: 0,
				full: 0,
			})
			const stopAt = (stop: 'deadline' | 'limit' | 'bound') =>
				Ref.update(tally, counted => ({
					...counted,
					stop: counted.stop ?? stop,
				}))
			// Each pull request counts its own left-out nodes, so one never holds another back.
			const judgeOne = Effect.fn('RaiseService.judgeOne')(function* (
				pr: OpenPullRequest
			) {
				if ((yield* Ref.get(tally)).stop !== undefined)
					return yield* Effect.void
				// The deadline stops only a later judgment: every tick judges the pull request at its start.
				if (
					deadline !== undefined &&
					(yield* Ref.get(tally)).scanned > 0 &&
					(yield* Clock.currentTimeMillis) >= deadline
				)
					return yield* stopAt('deadline')
				if (limit !== undefined && (yield* Ref.get(tally)).full >= limit)
					return yield* stopAt('limit')
				yield* Ref.update(tally, counted => ({
					...counted,
					current: pr.number,
				}))
				const judged = yield* Effect.result(
					Effect.gen(function* () {
						const judgment: RaiseJudgment = yield* judge(
							pr.number,
							pr.head.sha,
							allow
						)
						return {
							due: !(yield* isReadIncomplete) && isDue(judgment),
							full: judgment.full === true,
						}
					}).pipe(restartListCount)
				)
				return yield* Ref.update(tally, ({ current: _judged, ...counted }) => ({
					...counted,
					due:
						Result.isSuccess(judged) && judged.success.due
							? [...counted.due, pr.number]
							: counted.due,
					failed: counted.failed + (Result.isFailure(judged) ? 1 : 0),
					scanned: counted.scanned + 1,
					// A failed read counts against the limit, as its requests were made.
					full:
						counted.full +
						(Result.isFailure(judged) || judged.success.full ? 1 : 0),
				}))
			})
			// A judgment that started runs to its end and counts, unless the whole scan, its listing
			// included, reaches its bound: then what it judged is kept and the one in flight dropped.
			const scanAll = Effect.gen(function* () {
				const open = yield* github.listOpenPullRequests()
				yield* Ref.update(tally, counted => ({ ...counted, read: open.length }))
				// One rotation only, by a step that visits every start; the caller keeps this order.
				const start =
					open.length === 0
						? 0
						: ((scan?.rotation ?? 0) * getScanStride(limit, open.length)) %
							open.length
				const ordered = [...open.slice(start), ...open.slice(0, start)]
				yield* Effect.forEach(ordered, judgeOne, {
					concurrency: 1,
					discard: true,
				})
			})
			const bound = scan?.bound
			yield* bound === undefined
				? scanAll
				: scanAll.pipe(
						Effect.timeoutOrElse({
							duration: Duration.millis(
								Math.max(0, bound - (yield* Clock.currentTimeMillis))
							),
							orElse: () =>
								Ref.update(tally, (counted): ScanTally => ({
									...counted,
									stop: 'bound',
								})),
						})
					)
			const counted = yield* Ref.get(tally)
			const left = counted.read - counted.scanned
			const deferred = counted.stop === 'limit' ? left : 0
			return {
				pulls: counted.due,
				read: counted.read,
				failed: counted.failed,
				unscanned: left - deferred,
				deferred,
				...(counted.current === undefined ? {} : { dropped: counted.current }),
				...(counted.stop === 'bound' ? { stop: 'bound' } : {}),
			} satisfies RaiseFindResult
		})

		/**
		 * Dismisses `stale` unless the pull request closed or its head moved since the judgment: the
		 * dismissal acts on the pull request, not on the judged head.
		 */
		const lift = Effect.fn('RaiseService.lift')(function* (
			pullNumber: number,
			head: string,
			stale: readonly number[]
		) {
			if (stale.length === 0)
				return { gate: 'open', dismissal: NO_DISMISSAL } satisfies LiftResult
			const pr = yield* api.getPullRequest(pullNumber)
			if (pr.state !== 'open')
				return { gate: 'closed', dismissal: NO_DISMISSAL } satisfies LiftResult
			if (pr.head.sha !== head)
				return { gate: 'moved', dismissal: NO_DISMISSAL } satisfies LiftResult
			return {
				gate: 'open',
				dismissal: yield* dismissals.liftRequests(
					pullNumber,
					stale,
					toClearedMessage(head)
				),
			} satisfies LiftResult
		})

		const raise = Effect.fn('RaiseService.raise')(function* (
			pullNumber: number,
			allow: readonly string[]
		) {
			const pr = yield* api.getPullRequest(pullNumber)
			if (pr.state !== 'open')
				return {
					outcome: 'closed',
					dismissal: NO_DISMISSAL,
				} satisfies RaiseResult
			const head = pr.head.sha
			const judgment: RaiseJudgment = yield* judge(pullNumber, head, allow)
			const kept = (outcome: RaiseOutcome): RaiseResult => ({
				outcome,
				head,
				dismissal: NO_DISMISSAL,
			})
			if (yield* isReadIncomplete) return kept('incomplete')
			if (!isDue(judgment)) return kept('not-due')
			// The pull request and the status again right before the writes: a close, a push, or a status
			// the sweep or a person wrote since the judgment keeps everything.
			const latest = yield* api.getPullRequest(pullNumber)
			if (latest.state !== 'open') return kept('closed')
			if (latest.head.sha !== head) return kept('moved')
			if ((yield* github.getStatus(head))?.id !== judgment.previous?.id)
				return kept('changed')
			const { status, stale } = judgment
			// A refused status write is kept and reported; a dismissal due on its own still runs.
			const written: StatusWrite = status
				? yield* github.setStatus({ sha: head, ...status }).pipe(
						Effect.as({ status }),
						Effect.catchTag('GitHubApiError', error =>
							Effect.succeed({ statusError: error.message })
						)
					)
				: {}
			const lifted = yield* lift(pullNumber, head, stale)
			return {
				outcome: getWriteOutcome(written, lifted),
				head,
				...written,
				dismissal: lifted.dismissal,
				...(lifted.gate === 'moved' ? { movedBeforeDismissal: true } : {}),
				...(lifted.gate === 'closed' ? { closedBeforeDismissal: true } : {}),
			} satisfies RaiseResult
		})

		return { findDue, raise }
	})
).pipe(
	Layer.provide(
		Layer.mergeAll(PullStateServiceLive, ReviewDismissServiceLive).pipe(
			Layer.provide(ThreadReplyServiceLive)
		)
	)
)
