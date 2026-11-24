import { randomBytes } from 'node:crypto'
import {
	type RiskDescription,
	toRiskDescription,
	toRulesDigest,
} from '@mng-review/domain'
import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubRiskService } from '../../../platform/github-risk.service'
import type { OwnedIdentities } from '../../../platform/owned-identities.context'
import { getNewestStatus } from '../domain/risk-history.helper'
import {
	EMPTY_RISK_MARKER,
	getReusedLevel,
	toRebuiltRiskMarker,
} from '../domain/risk-marker.helper'
import {
	decideFullRating,
	decideThreadRating,
} from '../domain/risk-rating.helper'
import type {
	FullRiskInput,
	RiskRun,
	RiskStart,
	RiskTarget,
} from '../domain/risk-run.types'
import { ERROR_STATE, NONCE_BYTES } from '../domain/risk.constants'
import { RiskStepOneError } from '../domain/risk.errors'
import type {
	AppRiskStatus,
	MarkerRead,
	RatingBlock,
	WritingDecision,
} from '../domain/risk.types'
import { formatRiskComment } from '../presentation/rating-block.formatter'
import { type HeldRead, RiskReadService } from './risk-read.service'

/** A decision that writes, and what step 1 needs besides it. */
interface StepOneInput {
	readonly target: RiskTarget
	readonly held: HeldRead
	readonly decision: WritingDecision
	readonly base: string
	readonly marker: MarkerRead
	readonly history: boolean
	readonly tree: string | undefined
	readonly block?: RatingBlock
}

/** The rules digest the run's statuses and rated heads carry. */
function toTargetDigest(target: Pick<RiskTarget, 'rules'>): string {
	return toRulesDigest(
		target.rules.risk?.rubric ?? '',
		target.rules.config.risk
	)
}

/**
 * Write-order step 1 and the reads before it. Every run first reads the held level (timeline and
 * statuses); a full run then reads its floors from git, the threads, the risk comment with its
 * whole edit history and the app history, and decides its level before any write. Step 1 writes
 * `error` with the step-1 maximum and a new nonce, reads it back, and goes on only when it is the
 * newest app status for the number. It then creates the risk comment when none exists and the
 * pull request has no app history, or rewrites one someone else edited from the app's statuses,
 * which can only raise. A person's edit that rewrite overwrote stays in the edit history, which
 * the next full run reads before its own step 1.
 */
export class RiskStartService extends Context.Service<
	RiskStartService,
	{
		readonly startFull: (
			input: FullRiskInput
		) => Effect.Effect<RiskRun, RiskStepOneError, OwnedIdentities>
		readonly startThread: (
			target: RiskTarget
		) => Effect.Effect<RiskStart, RiskStepOneError, OwnedIdentities>
	}
>()('mng-review/RiskStartService') {}

export const RiskStartServiceLive = Layer.effect(
	RiskStartService,
	Effect.gen(function* () {
		const reads = yield* RiskReadService
		const risk = yield* GitHubRiskService
		const api = yield* GitHubApiService

		/**
		 * Creates the risk comment, or rewrites an edited one; a failed create leaves the run
		 * unrated. The rewrite goes only over the edit step 1 read, checked against the edit history
		 * read just before it, so a later edit waits for the next run. GitHub has no conditional
		 * comment update, so a person's edit between that read and the update is overwritten; its
		 * text stays in the edit history, and the next full run carries what it named
		 * (`readEditedLevel`), whether or not GitHub answered the update.
		 */
		const writeMarker = Effect.fn('RiskStartService.writeMarker')(function* (
			input: StepOneInput,
			statuses: readonly AppRiskStatus[]
		) {
			const { marker, target } = input
			if (marker.status === 'none' && !input.history) {
				const body = formatRiskComment(EMPTY_RISK_MARKER)
				return yield* api.createIssueComment(target.pullNumber, body).pipe(
					Effect.map((id): MarkerRead => ({
						status: 'trusted',
						id,
						body,
						marker: EMPTY_RISK_MARKER,
					})),
					Effect.orElseSucceed((): MarkerRead => ({ status: 'failed' }))
				)
			}
			if (marker.status !== 'edited') return marker
			const grants = [...new Set(statuses.map(status => status.sha))]
			const trees = new Map(
				(yield* Effect.all(
					grants.map(sha =>
						reads.readTree(sha).pipe(Effect.map(tree => [sha, tree] as const))
					)
				)).flatMap(([sha, tree]) =>
					tree === undefined ? [] : [[sha, tree] as const]
				)
			)
			const before = yield* risk
				.readCommentEdits(marker.nodeId)
				.pipe(Effect.orElseSucceed(() => undefined))
			if (before?.body !== marker.body) return marker
			const rebuilt = toRebuiltRiskMarker(statuses, trees, marker.named)
			yield* api
				.updateIssueComment(marker.id, formatRiskComment(rebuilt))
				.pipe(Effect.ignore)
			return marker
		})

		/** Step 1: `error` at the step-1 maximum, read back, then the risk comment. */
		const stepOne = Effect.fn('RiskStartService.stepOne')(function* (
			input: StepOneInput
		) {
			const { target, decision } = input
			const description = {
				pr: target.pullNumber,
				level: decision.stepOne,
				floor: decision.floor,
				base: input.base,
				rules: toTargetDigest(target),
				nonce: randomBytes(NONCE_BYTES).toString('hex'),
			} satisfies RiskDescription
			yield* risk
				.createStatus({
					sha: target.head,
					state: ERROR_STATE,
					description: toRiskDescription(description),
				})
				.pipe(
					Effect.mapError(
						error =>
							new RiskStepOneError({
								stage: 'status-create',
								reason: error.message,
							})
					)
				)
			const onHead = yield* reads
				.readHeadStatuses(target.pullNumber, target.head)
				.pipe(
					Effect.mapError(
						error =>
							new RiskStepOneError({ stage: 'read-back', reason: error.reason })
					)
				)
			if (
				getNewestStatus(onHead, target.head)?.description.nonce !==
				description.nonce
			)
				return yield* new RiskStepOneError({
					stage: 'read-back',
					reason:
						'the newest app status for this number is not the one this run wrote',
				})
			// The read-back replaces only this app's statuses on the head; a previous app's stay.
			const others = input.held.statuses.filter(
				status => status.sha !== target.head || !status.current
			)
			const marker = yield* writeMarker(input, [...others, ...onHead])
			const lost = marker.status === 'failed' && input.marker.status === 'none'
			const gap = {
				reason: 'publish-failed',
				detail: 'the risk comment could not be created',
			} as const
			// The block shows the final decision, so a lost comment never shows a rated level.
			const block: RatingBlock | undefined =
				lost && input.block
					? { status: 'unrated', ...gap, floors: input.block.floors }
					: input.block
			return {
				pullNumber: target.pullNumber,
				head: target.head,
				baseSha: target.baseSha,
				defaultBranch: target.defaultBranch,
				labels: target.rules.config.risk.labels,
				held: input.held.held,
				description,
				decision: lost
					? {
							status: 'unrated',
							...gap,
							floor: decision.floor,
							stepOne: decision.stepOne,
						}
					: decision,
				marker,
				tree: input.tree,
				...(block ? { block } : {}),
			} satisfies RiskRun
		})

		const startFull = Effect.fn('RiskStartService.startFull')(function* (
			input: FullRiskInput
		) {
			const { pullNumber, head } = input
			const held = yield* reads.readHeld(pullNumber, head)
			const base = yield* reads.readMergeBase(input)
			const marker = yield* reads.readMarker(pullNumber)
			const edits = yield* reads.readEditedLevel(marker)
			const history =
				marker.status === 'none'
					? yield* reads.readHistory(pullNumber, held.statuses)
					: true
			const floors = yield* reads.readFloors(base, head, input.rules)
			const tree = yield* reads.readTree(head)
			const threadBugs = yield* reads.readThreadBugs(pullNumber, [])
			const { rating } = input.report
			const reused =
				marker.status === 'trusted' && tree !== undefined
					? getReusedLevel(marker.marker, {
							tree,
							base,
							rules: toTargetDigest(input),
						})
					: undefined
			const decision = decideFullRating({
				rating,
				floors,
				routerRisky: input.report.planReport.plan.router.risk === 'risky',
				confirmedBugs: [
					...input.report.bugs
						.filter(bug => bug.validation?.status === 'confirmed')
						.map(bug => bug.severity),
					...(threadBugs ?? []),
				],
				threadsRead: threadBugs !== undefined,
				marker,
				history,
				reused,
				held: held.held,
				edits,
			})
			const hits = floors?.hits ?? []
			const block: RatingBlock =
				decision.status === 'rated'
					? {
							status: 'rated',
							level: decision.level,
							floors: hits,
							reasons:
								rating?.status === 'rated' && reused === undefined
									? rating.reasons
									: [],
							reused: reused !== undefined,
						}
					: {
							status: 'unrated',
							reason: decision.reason,
							detail: decision.detail,
							floors: hits,
						}
			return yield* stepOne({
				target: input,
				held,
				decision,
				base,
				marker,
				history,
				tree,
				block,
			})
		})

		const startThread = Effect.fn('RiskStartService.startThread')(function* (
			target: RiskTarget
		) {
			const { pullNumber, head } = target
			const held = yield* reads.readHeld(pullNumber, head)
			const threadBugs = yield* reads.readThreadBugs(
				pullNumber,
				target.answered ?? []
			)
			const marker = yield* reads.readMarker(pullNumber)
			const history =
				marker.status === 'none'
					? yield* reads.readHistory(pullNumber, held.statuses)
					: true
			const decision = decideThreadRating({
				confirmedBugs: [...(threadBugs ?? []), ...(target.openBugs ?? [])],
				threadsRead: threadBugs !== undefined,
				marker,
				history,
				held: held.held,
			})
			if (decision.status === 'none')
				return { status: 'none' } satisfies RiskStart
			const base = yield* reads.readMergeBase(target)
			const run = yield* stepOne({
				target,
				held,
				decision,
				base,
				marker,
				history,
				tree: undefined,
			})
			return { status: 'started', run } satisfies RiskStart
		})

		return { startFull, startThread }
	})
)
