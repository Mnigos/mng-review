import {
	getHigherLevel,
	type RiskDescription,
	type RiskLevel,
	type StatusLevel,
	toRiskDescription,
} from '@mng-review/domain'
import { Context, Effect, Layer, Predicate } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubRiskService } from '../../../platform/github-risk.service'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	BASE_BRANCH_STOP,
	HELD_READ_STOP,
	MARKER_EDITS_STOP,
	MARKER_WRITE_STOP,
	NONCE_LOST_STOP,
	NONCE_READ_STOP,
	THREAD_RAISE_STOP,
	THREAD_READ_STOP,
} from '../domain/grant-stop.constants'
import { getNewestStatus } from '../domain/risk-history.helper'
import {
	getMarkerEditStop,
	toNextRiskMarker,
	toRaisedRiskMarker,
} from '../domain/risk-marker.helper'
import { hasThreadRaise } from '../domain/risk-rating.helper'
import type { RiskResult, RiskRun } from '../domain/risk-run.types'
import { ERROR_STATE, HIGH_STATE } from '../domain/risk.constants'
import type { GrantStop } from '../domain/risk.types'
import { formatRiskComment } from '../presentation/rating-block.formatter'
import {
	type LabelTarget,
	RiskLabelService,
	RiskLabelServiceLive,
} from './risk-label.service'
import { RiskReadService } from './risk-read.service'

/** A revocation from a cleanup step: the step-1 description when the run reached it. */
export interface RevokeInput extends LabelTarget {
	readonly description?: RiskDescription
}

/** A stop when a held level is above the level the run would grant. */
function getHeldStop(
	held: StatusLevel,
	level: RiskLevel
): GrantStop | undefined {
	if (getHigherLevel(held, level) === level) return undefined
	return {
		reason: 'publish-failed',
		detail: `the held level ${held} is above ${level}`,
	}
}

/**
 * Write-order steps 3 to 6 and the revocation. A rated run checks its nonce, updates the risk
 * comment (it only adds heads and raises), checks its nonce again, sets the label, reads again
 * that the head, its base branch and merge base, its nonce, the comment, the confirmed bug threads
 * and the held level on every head still allow the grant, writes the grant last and reads it back.
 * A run not rated, a label step that failed, and any check that fails, remove the bot's label and
 * leave step 1's `error`; a run whose nonce another run replaced changes nothing more, since the
 * comment and the label are that run's now. A run not rated checks its nonce before that too. A
 * revocation writes that `error` again, never a lower level, and removes the label, unless a newer
 * run's status is already the newest.
 */
export class RiskFinishService extends Context.Service<
	RiskFinishService,
	{
		readonly finish: (
			run: RiskRun
		) => Effect.Effect<RiskResult, never, OwnedIdentities>
		readonly revoke: (
			run: RiskRun
		) => Effect.Effect<RiskResult, never, OwnedIdentities>
		/** The cleanup step's revocation, from the description step 1 wrote, if any. */
		readonly revokeHead: (
			input: RevokeInput
		) => Effect.Effect<RiskResult, never, OwnedIdentities>
	}
>()('mng-review/RiskFinishService') {}

export const RiskFinishServiceLive = Layer.effect(
	RiskFinishService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const risk = yield* GitHubRiskService
		const reads = yield* RiskReadService
		const labels = yield* RiskLabelService

		/** Why the run must stop because its nonce is no longer the newest status, if it must. */
		const checkNonce = Effect.fn('RiskFinishService.checkNonce')(function* (
			run: RiskRun
		) {
			const onHead = yield* reads
				.readHeadStatuses(run.pullNumber, run.head)
				.pipe(Effect.orElseSucceed(() => undefined))
			if (!onHead) return NONCE_READ_STOP
			if (
				getNewestStatus(onHead, run.head)?.description.nonce !==
				run.description.nonce
			)
				return NONCE_LOST_STOP
			return undefined
		})

		/**
		 * The run left unrated: the label goes and step 1's `error` stays. After a lost nonce the
		 * newest status and the label are another run's, so nothing changes.
		 */
		const leaveUnrated = Effect.fn('RiskFinishService.leaveUnrated')(function* (
			run: RiskRun,
			stop: GrantStop
		) {
			if (stop.reason === NONCE_LOST_STOP.reason)
				return {
					state: 'none',
					level: run.description.level,
					...stop,
				} satisfies RiskResult
			const labeled = yield* labels.sync(run, undefined)
			return {
				state: 'error',
				level: run.description.level,
				...stop,
				...(labeled ? {} : { labelFailed: true }),
			} satisfies RiskResult
		})

		/**
		 * Step 3: the risk comment with this head added, or for a thread raise its highest raised. It
		 * builds on the comment as it is now, never on the copy step 1 read, and stops when someone
		 * else edited it. GitHub has no conditional comment update, so the comment's edit history is
		 * read before and after the update: an edit by anyone else in between was overwritten, and
		 * the run stays unrated. A person's edit can raise (its named level counts in step 1), so
		 * losing it unseen could lose a High. A risk label a person sets higher than the status does
		 * not raise the status, but the merge script refuses a pull request with such a label.
		 * Another run's update in between is the app's own; that run's step 5 sees its entry gone.
		 */
		const updateMarker = Effect.fn('RiskFinishService.updateMarker')(function* (
			run: RiskRun,
			level: RiskLevel
		) {
			const { current: app } = yield* OwnedIdentities
			const current = yield* reads.readMarker(run.pullNumber)
			if (current.status === 'edited')
				return {
					reason: 'marker-edited',
					detail: 'someone else edited the risk comment after step 1',
				} satisfies GrantStop
			if (current.status !== 'trusted' || current.nodeId === undefined)
				return MARKER_WRITE_STOP
			const { nodeId } = current
			const before = yield* risk
				.readCommentEdits(nodeId)
				.pipe(Effect.orElseSucceed(() => undefined))
			if (!before) return MARKER_EDITS_STOP
			if (before.body !== current.body)
				return {
					reason: 'marker-edited',
					detail: 'the risk comment changed while this run read it',
				} satisfies GrantStop
			const next =
				run.tree === undefined
					? toRaisedRiskMarker(current.marker, level)
					: toNextRiskMarker(current.marker, {
							head: run.head,
							tree: run.tree,
							base: run.description.base,
							rules: run.description.rules,
							level,
						})
			const body = formatRiskComment(next)
			const updated = yield* api.updateIssueComment(current.id, body).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false)
			)
			if (!updated) return MARKER_WRITE_STOP
			const after = yield* risk
				.readCommentEdits(nodeId)
				.pipe(Effect.orElseSucceed(() => undefined))
			if (!after) return MARKER_EDITS_STOP
			return getMarkerEditStop(before, after, app) ?? body
		})

		/** True when the pull request's base still gives the merge base step 1 rated against. */
		const keepsMergeBase = Effect.fn('RiskFinishService.keepsMergeBase')(
			function* (run: RiskRun, baseSha: string) {
				if (baseSha === run.baseSha) return true
				const base = yield* reads
					.readMergeBase({ baseSha, head: run.head })
					.pipe(Effect.orElseSucceed(() => undefined))
				return base === run.description.base
			}
		)

		/**
		 * Step 5: why the grant must not be written, or `undefined` when everything still holds. The
		 * pull request must still be into the default branch. The held level is read again across
		 * every head the timeline lists, not only this one, and below High the threads too, since a
		 * person can reopen a confirmed High bug after step 1.
		 */
		const checkGrant = Effect.fn('RiskFinishService.checkGrant')(function* (
			run: RiskRun,
			level: RiskLevel,
			body: string
		) {
			const pr = yield* api
				.getPullRequest(run.pullNumber)
				.pipe(Effect.orElseSucceed(() => undefined))
			if (pr?.head.sha !== run.head)
				return {
					reason: 'head-moved',
					detail: 'the pull request moved to another head',
				} satisfies GrantStop
			if (pr.base.ref !== run.defaultBranch) return BASE_BRANCH_STOP
			if (!(yield* keepsMergeBase(run, pr.base.sha)))
				return {
					reason: 'head-moved',
					detail: 'the merge base changed or could not be read again',
				} satisfies GrantStop
			const held = yield* reads
				.readHeld(run.pullNumber, run.head)
				.pipe(Effect.orElseSucceed(() => undefined))
			if (!held) return HELD_READ_STOP
			if (
				getNewestStatus(held.statuses, run.head)?.description.nonce !==
				run.description.nonce
			)
				return NONCE_LOST_STOP
			const marker = yield* reads.readMarker(run.pullNumber)
			if (marker.status !== 'trusted' || marker.body !== body)
				return {
					reason: 'marker-edited',
					detail: 'the risk comment changed before the grant',
				} satisfies GrantStop
			if (level !== 'high') {
				const bugs = yield* reads.readThreadBugs(run.pullNumber, [])
				if (!bugs) return THREAD_READ_STOP
				if (hasThreadRaise(bugs)) return THREAD_RAISE_STOP
			}
			return getHeldStop(held.held, level)
		})

		/** Writes step 1's `error` again on the head, never a lower level; true when it was written. */
		const writeStepOne = Effect.fn('RiskFinishService.writeStepOne')(function* (
			target: Pick<LabelTarget, 'head'>,
			description: RiskDescription
		) {
			return yield* risk
				.createStatus({
					sha: target.head,
					state: ERROR_STATE,
					description: toRiskDescription(description),
				})
				.pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false)
				)
		})

		/**
		 * Step 6: the grant, then a read of every head again. That read settles a write whose answer
		 * was lost (the grant stands when it is the newest status) and catches a higher level that
		 * landed between step 5 and the write. A grant that does not stand, or cannot be read back,
		 * gets step 1's `error` over it; when that write is refused too, the result says the grant
		 * may stand, which fails the job so the cleanup step tries again. When another run's status
		 * is already the newest, that one stands and nothing is written.
		 */
		const grant = Effect.fn('RiskFinishService.grant')(function* (
			run: RiskRun,
			level: RiskLevel
		) {
			const state = level === 'high' ? HIGH_STATE : 'success'
			yield* risk
				.createStatus({
					sha: run.head,
					state,
					description: toRiskDescription({ ...run.description, level }),
				})
				.pipe(Effect.ignore)
			const after = yield* reads
				.readHeld(run.pullNumber, run.head)
				.pipe(Effect.orElseSucceed(() => undefined))
			const newest = after && getNewestStatus(after.statuses, run.head)
			if (after && newest?.description.nonce !== run.description.nonce)
				return yield* leaveUnrated(run, NONCE_LOST_STOP)
			if (after && newest?.state !== state)
				return yield* leaveUnrated(run, {
					reason: 'publish-failed',
					detail: 'the grant could not be written',
				})
			const stop: GrantStop | undefined = after
				? getHeldStop(after.held, level)
				: {
						reason: 'publish-failed',
						detail: 'the grant could not be read back',
					}
			if (stop === undefined) return { state, level } satisfies RiskResult
			const revoked = yield* writeStepOne(run, run.description)
			const left = yield* leaveUnrated(run, stop)
			return revoked ? left : { ...left, grantStands: true }
		})

		const finish = Effect.fn('RiskFinishService.finish')(function* (
			run: RiskRun
		) {
			const { decision } = run
			// A newer run may hold the label already; a failed read still removes it (fails closed).
			if (decision.status === 'unrated') {
				const lost = yield* checkNonce(run)
				return yield* leaveUnrated(
					run,
					lost === NONCE_LOST_STOP ? lost : decision
				)
			}
			const { level } = decision
			const unheld = yield* checkNonce(run)
			if (unheld) return yield* leaveUnrated(run, unheld)
			const body = yield* updateMarker(run, level)
			if (!Predicate.isString(body)) return yield* leaveUnrated(run, body)
			const replaced = yield* checkNonce(run)
			if (replaced) return yield* leaveUnrated(run, replaced)
			const labeled = yield* labels.sync(run, level)
			if (!labeled)
				return yield* leaveUnrated(run, {
					reason: 'publish-failed',
					detail: 'the risk label could not be set',
				})
			const stop = yield* checkGrant(run, level, body)
			if (stop) return yield* leaveUnrated(run, stop)
			return yield* grant(run, level)
		})

		/**
		 * Writes step 1's `error` again and removes the bot's label, but only while this run's nonce is
		 * still the newest status: a newer run's status and label stand. When that read fails it writes
		 * anyway (ADR 0012): the `error` never grants and carries step 1's level, so no held level
		 * drops, and it revokes this run's own grant if that is still the newest. A newer run's grant
		 * it replaces is lost until the next run.
		 */
		const revokeHead = Effect.fn('RiskFinishService.revokeHead')(function* (
			input: RevokeInput
		) {
			const { description } = input
			const onHead = description
				? yield* reads
						.readHeadStatuses(input.pullNumber, input.head)
						.pipe(Effect.orElseSucceed(() => undefined))
				: undefined
			const newest = onHead && getNewestStatus(onHead, input.head)
			if (
				description &&
				newest &&
				newest.description.nonce !== description.nonce
			)
				return {
					state: 'none',
					level: description.level,
					...NONCE_LOST_STOP,
				} satisfies RiskResult
			const written = description
				? yield* writeStepOne(input, description)
				: false
			const labeled = yield* labels.sync(input, undefined)
			return {
				state: written ? 'error' : 'none',
				level: description?.level ?? 'none',
				reason: 'publish-failed',
				...(labeled ? {} : { labelFailed: true }),
			} satisfies RiskResult
		})

		const revoke = Effect.fn('RiskFinishService.revoke')(function* (
			run: RiskRun
		) {
			return yield* revokeHead({
				pullNumber: run.pullNumber,
				head: run.head,
				labels: run.labels,
				description: run.description,
			})
		})

		return { finish, revoke, revokeHead }
	})
).pipe(Layer.provide(RiskLabelServiceLive))
