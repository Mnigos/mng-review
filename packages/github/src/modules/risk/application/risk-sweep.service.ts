import { toAnswerDigest } from '@mng-review/domain'
import { Clock, Context, Effect, Layer, Ref } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import type { WorkflowRun } from '../../../platform/github-risk.schema'
import { GitHubRiskService } from '../../../platform/github-risk.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import type { OwnedIdentities } from '../../../platform/owned-identities.context'
import { toGitHubTime } from '../../../utils/github-time.util'
import {
	BRIDGE_RUN_TITLE,
	DISPATCH_EVENT,
	HEAD_DISPATCH_AT,
	HEAD_DISPATCH_VERSION,
	IN_FLIGHT_STATUSES,
	PUSH_EVENT,
	RATING_EVENTS,
	RISK_RUN_TITLE,
} from '../domain/risk.constants'
import type { RiskStepOneError } from '../domain/risk.errors'
import {
	type DispatchKey,
	type DispatchKind,
	type DispatchVerdict,
	countHeadDispatches,
	getDispatchVerdict,
	toDispatchInputs,
} from '../domain/sweep-dispatch.helper'
import {
	getHeadArrival,
	getLatestTime,
	isReviewRun,
	type RatingRun,
} from '../domain/sweep-hold.helper'
import {
	isFullRating,
	toEntryQualifier,
	toSweptRun,
} from '../domain/sweep-run.helper'
import { RiskReadService } from './risk-read.service'
import {
	type CandidateCheck,
	type CandidateReason,
	getOldestHold,
	type SweepCandidate,
	SweepCandidateService,
	SweepCandidateServiceLive,
} from './sweep-candidate.service'

/** The one open pull request a sweep job checks, inside its group, and what the dispatch needs. */
export interface SweepPullInput {
	readonly pullNumber: number
	readonly head: string
	/** When the pull request was created; no run for it is older, so no runs list starts earlier. */
	readonly since?: string
	/** The repository's id; only its own runs count. */
	readonly repositoryId: number
	/**
	 * Whether the checks the dispatched run makes before any model call pass, per kind: `review`
	 * the dispatched rating's (not a fork, base is default, not a draft, and the review job's gate:
	 * skip labels, skipped authors and targets); `converse` the converse's own (fork, base, draft).
	 */
	readonly checks: Readonly<Record<DispatchKind, boolean>>
	readonly maxRuns: number
	/**
	 * The review workflow file the sweep dispatches; unset, nothing is dispatched and a dispatch the
	 * sweep needed is reported as `no-workflow`.
	 */
	readonly workflow?: string
	readonly defaultBranch: string
}

/** Why the sweep dispatched, or held off. */
export type SweepReason = 'no-status' | CandidateReason

/** What the sweep did for one pull request. */
export interface SweepPullResult {
	readonly pullNumber: number
	readonly reason?: SweepReason
	/**
	 * `dispatch` when it dispatched; otherwise why not, `no-workflow` when it needed a dispatch but
	 * has no workflow to dispatch, or `none` when nothing holds.
	 */
	readonly verdict: DispatchVerdict | 'no-workflow' | 'none'
}

/** The dispatch key of the comment that holds the pull request, on its head. */
function toCandidateKey(candidate: SweepCandidate, head: string): DispatchKey {
	return {
		kind: candidate.kind,
		id: candidate.comment.id,
		digest: toAnswerDigest(candidate.comment.body),
		at: candidate.comment.at,
		head,
	}
}

/** True for a run named for the pull request: a writer or its bridge. */
function isTitledFor(run: WorkflowRun, pullNumber: number): boolean {
	return (
		run.display_title === `${RISK_RUN_TITLE}${pullNumber}` ||
		run.display_title === `${BRIDGE_RUN_TITLE}${pullNumber}`
	)
}

/**
 * The risk pass of `status-sweep.yml` for one open pull request, run by its matrix job inside the
 * pull request's group, before any model call. When its head has no app status for its number it
 * dispatches a full `review`; else for a thread reply no app answer names it dispatches the
 * converse; else for a review body or a thread an acted-on author started with no rating since it
 * dispatches a `review`. Each dispatch first passes its kind's pre-model checks, the repeat rule
 * and the run limit; one dispatch per pass. A comment the repeat rule blocks is passed over for the
 * next one that holds, so one failed converse never keeps another comment from its dispatch. The
 * review workflow's runs are listed only from the oldest comment that may hold, or from the head's
 * arrival for an unrated head, so a long-open pull request in a busy repository stays under the
 * runs search's 1,000 results; the run limit reads the head's dispatches from its arrival, which
 * on a long-lived head can pass that limit too. A failed read, the role read and a runs list past
 * its limit included, fails the call, so nothing is dispatched and the holds stay.
 */
export class RiskSweepService extends Context.Service<
	RiskSweepService,
	{
		readonly sweepPull: (
			input: SweepPullInput
		) => Effect.Effect<
			SweepPullResult,
			GitHubApiError | RiskStepOneError,
			OwnedIdentities
		>
	}
>()('mng-review/RiskSweepService') {}

export const RiskSweepServiceLive = Layer.effect(
	RiskSweepService,
	Effect.gen(function* () {
		const risk = yield* GitHubRiskService
		const api = yield* GitHubApiService
		const reads = yield* RiskReadService
		const candidates = yield* SweepCandidateService

		/**
		 * Whether a run named for the pull request is in flight (listed from its creation), and its
		 * runs of the review workflow from the repository itself created from `from` on, with their
		 * fixed jobs; none without a workflow.
		 */
		const readRuns = Effect.fn('RiskSweepService.readRuns')(function* (
			input: SweepPullInput,
			from: string | undefined
		) {
			const { since, workflow } = input
			const inFlight = yield* Effect.all(
				IN_FLIGHT_STATUSES.map(status =>
					risk.listRuns({ status, ...(since ? { since } : {}) })
				)
			)
			const flying = inFlight
				.flat()
				.some(run => isTitledFor(run, input.pullNumber))
			if (workflow === undefined) return { flying, swept: [] }
			const bound = getLatestTime([since, from])
			const started = yield* Effect.all([
				...RATING_EVENTS.map(event =>
					risk.listRuns({
						workflow,
						event,
						branch: input.defaultBranch,
						...(bound ? { since: bound } : {}),
					})
				),
				// A push run's branch is the pull request's own, so only the event filters it.
				risk.listRuns({
					workflow,
					event: PUSH_EVENT,
					...(bound ? { since: bound } : {}),
				}),
			])
			const own = [
				...new Map(started.flat().map(run => [run.id, run])).values(),
			].filter(run => isReviewRun(run, { ...input, workflow }))
			const swept = yield* Effect.forEach(
				own,
				run =>
					risk
						.listRunJobs(run.id)
						.pipe(Effect.map(jobs => toSweptRun(run, jobs))),
				{ concurrency: 1 }
			)
			return { flying, swept }
		})

		/**
		 * The sweep's dispatches on the head since it arrived (its force push, else the pull request's
		 * creation), from their own read of the dispatched runs, so a new comment that moves the
		 * comment-based lower bound never resets the run limit. Only a decide job named with the
		 * sweep's source carries a key, so a bridge dispatch never counts. None without a workflow.
		 */
		const countOnHead = Effect.fn('RiskSweepService.countOnHead')(function* (
			input: SweepPullInput
		) {
			const { workflow } = input
			if (workflow === undefined) return 0
			const items = yield* risk.listTimeline(input.pullNumber)
			const now = toGitHubTime(yield* Clock.currentTimeMillis)
			const bound = getLatestTime([
				input.since,
				getHeadArrival(items, input.head, now),
			])
			const runs = yield* risk.listRuns({
				workflow,
				event: DISPATCH_EVENT,
				branch: input.defaultBranch,
				...(bound ? { since: bound } : {}),
			})
			const keys = yield* Effect.forEach(
				runs.filter(run => isReviewRun(run, { ...input, workflow })),
				run =>
					risk
						.listRunJobs(run.id)
						.pipe(Effect.map(jobs => toSweptRun(run, jobs).key)),
				{ concurrency: 1 }
			)
			return keys.filter(key => key?.head === input.head).length
		})

		/** Dispatches the key when the verdict allows it and a workflow is set. */
		const finish = Effect.fn('RiskSweepService.finish')(function* (
			input: SweepPullInput,
			key: DispatchKey,
			verdict: DispatchVerdict
		) {
			if (verdict !== 'dispatch') return verdict
			if (input.workflow === undefined) return 'no-workflow' as const
			yield* risk.dispatch({
				workflow: input.workflow,
				ref: input.defaultBranch,
				inputs: toDispatchInputs(input.pullNumber, key),
			})
			return verdict
		})

		/**
		 * An unrated head: one full `review` keyed by the pull request, its runs listed from its
		 * arrival.
		 */
		const sweepHead = Effect.fn('RiskSweepService.sweepHead')(function* (
			input: SweepPullInput
		) {
			const { pullNumber, head } = input
			const key = {
				kind: 'review',
				id: pullNumber,
				digest: HEAD_DISPATCH_VERSION,
				at: HEAD_DISPATCH_AT,
				head,
			} as const satisfies DispatchKey
			if (!input.checks.review)
				return {
					pullNumber,
					reason: 'no-status',
					verdict: 'checks-failed',
				} satisfies SweepPullResult
			const items = yield* risk.listTimeline(pullNumber)
			const now = toGitHubTime(yield* Clock.currentTimeMillis)
			const { flying, swept } = yield* readRuns(
				input,
				getHeadArrival(items, head, now)
			)
			const keyed = swept.flatMap(entry =>
				entry.key ? [{ key: entry.key, conclusion: entry.group }] : []
			)
			const verdict: DispatchVerdict = flying
				? 'in-flight'
				: countHeadDispatches(keyed, head) >= input.maxRuns
					? 'run-limit'
					: 'dispatch'
			return {
				pullNumber,
				reason: 'no-status',
				verdict: yield* finish(input, key, verdict),
			} satisfies SweepPullResult
		})

		const sweepPull = Effect.fn('RiskSweepService.sweepPull')(function* (
			input: SweepPullInput
		) {
			const { pullNumber, head } = input
			const statuses = yield* reads.readHeadStatuses(pullNumber, head)
			if (statuses.length === 0) return yield* sweepHead(input)
			const raw = yield* api.listReviewThreads(pullNumber)
			const holders = yield* candidates.gather(pullNumber, raw)
			const oldest = getOldestHold(holders)
			if (oldest === undefined)
				return { pullNumber, verdict: 'none' } satisfies SweepPullResult
			const { flying, swept } = yield* readRuns(input, oldest)
			const keyed = swept.flatMap(entry =>
				entry.key
					? [
							{
								key: entry.key,
								conclusion: entry.group,
								...(entry.decide === undefined ? {} : { decide: entry.decide }),
							},
						]
					: []
			)
			const rated: RatingRun[] = swept.filter(isFullRating).map(entry => ({
				createdAt: entry.run.created_at,
				conclusion: entry.rating,
			}))
			// Read once, and only when a comment still holds.
			const onHead = yield* Effect.cached(countOnHead(input))
			const toVerdict = (key: DispatchKey) =>
				flying
					? Effect.succeed<DispatchVerdict>('in-flight')
					: onHead.pipe(
							Effect.map(count =>
								getDispatchVerdict({
									key,
									runs: keyed,
									checksPass: input.checks[key.kind],
									maxRuns: input.maxRuns,
									onHead: count,
								})
							)
						)
			// The first blocked comment, reported when no other comment can dispatch.
			const blocked = yield* Ref.make<SweepCandidate | undefined>(undefined)
			const isOpen: CandidateCheck = candidate =>
				toVerdict(toCandidateKey(candidate, head)).pipe(
					Effect.flatMap(verdict =>
						verdict === 'blocked'
							? Ref.update(blocked, first => first ?? candidate).pipe(
									Effect.as(false)
								)
							: Effect.succeed(true)
					)
				)
			const candidate = yield* candidates.choose({
				holders,
				qualifies: toEntryQualifier(swept),
				rated,
				isOpen,
			})
			const chosen = candidate ?? (yield* Ref.get(blocked))
			if (!chosen)
				return { pullNumber, verdict: 'none' } satisfies SweepPullResult
			const key = toCandidateKey(chosen, head)
			return {
				pullNumber,
				reason: chosen.reason,
				verdict: candidate
					? yield* finish(input, key, yield* toVerdict(key))
					: 'blocked',
			} satisfies SweepPullResult
		})

		return { sweepPull }
	})
).pipe(Layer.provide(SweepCandidateServiceLive))
