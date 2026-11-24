import {
	type FloorReport,
	getFloorReport,
	type StatusLevel,
} from '@mng-review/domain'
import { FloorDiffService, GitService, type Rules } from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubReviewService } from '../../../platform/github-review.service'
import type { TimelineItem } from '../../../platform/github-risk.schema'
import { GitHubRiskService } from '../../../platform/github-risk.service'
import { provideListCompleteness } from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { PublishService } from '../../publish/application/publish.service'
import { isUnsettled } from '../../publish/domain/bot-thread.helper'
import type { BotThread } from '../../publish/domain/publish.types'
import {
	getHeldOwners,
	getStatusesHighest,
	getTimelineHeads,
	hasAppHistory,
	type StatusOwners,
	toAppRiskStatuses,
} from '../domain/risk-history.helper'
import { getEditedLevel, toMarkerRead } from '../domain/risk-marker.helper'
import { RiskStepOneError } from '../domain/risk.errors'
import type {
	AppRiskStatus,
	MarkerRead,
	RiskHistory,
} from '../domain/risk.types'

/** Statuses of commits read at once in the held read. */
const STATUS_READ_CONCURRENCY = 4

/** The held read with the timeline it came from. */
export interface HeldRead extends RiskHistory {
	readonly items: readonly TimelineItem[]
}

/** The two commits a floor diff and a description read: the bound base and the head. */
export interface RiskRange {
	readonly baseSha: string
	readonly head: string
}

/**
 * The reads the rating makes, each with its failure rule: the held read fails the job, a marker,
 * thread or history read that fails leaves the run unrated, and git reads that fail are
 * `undefined`.
 */
export class RiskReadService extends Context.Service<
	RiskReadService,
	{
		/**
		 * Every head the timeline lists and the statuses for this number on each, from the token's
		 * app and the previous apps of `identity.previous` (never the job token); any failure fails
		 * with `RiskStepOneError`. In a full run that is before publish's first write (the review
		 * job's model calls have already run, ADR 0012); a thread run reads it after its replies
		 * were posted. That includes a 404 for a head's statuses, a commit or force push the
		 * timeline lists without its commit, and a timeline or status list past `MAX_PAGES` pages
		 * (2,000 entries), so such a pull request stays unrated and its owner merges it.
		 */
		readonly readHeld: (
			pullNumber: number,
			head: string
		) => Effect.Effect<HeldRead, RiskStepOneError, OwnedIdentities>
		/** The token's own app's statuses for this number on one commit, newest first; a 404 fails. */
		readonly readHeadStatuses: (
			pullNumber: number,
			head: string
		) => Effect.Effect<
			readonly AppRiskStatus[],
			RiskStepOneError,
			OwnedIdentities
		>
		readonly readMarker: (
			pullNumber: number
		) => Effect.Effect<MarkerRead, never, OwnedIdentities>
		/**
		 * The highest level any edit of the risk comment by someone other than the token's app named
		 * in its whole edit history, so an edit an app write overwrote still counts; `none` without a
		 * comment to read, `undefined` when the history could not be read or the comment has no node
		 * id to read it by.
		 */
		readonly readEditedLevel: (
			marker: MarkerRead
		) => Effect.Effect<StatusLevel | undefined, never, OwnedIdentities>
		/**
		 * App history from the statuses and the reviews of the token's app and the previous apps; a
		 * failed review read counts as history.
		 */
		readonly readHistory: (
			pullNumber: number,
			statuses: readonly AppRiskStatus[]
		) => Effect.Effect<boolean, never, OwnedIdentities>
		/**
		 * Severities of the confirmed bug threads that are open, that this run answered without
		 * closing them (`answered`), or whose newest app answer is unsettled, or `undefined` when a
		 * read failed. Its reads are complete whatever the run provides: a null node is a failed read.
		 */
		readonly readThreadBugs: (
			pullNumber: number,
			answered: readonly string[]
		) => Effect.Effect<readonly string[] | undefined, never, OwnedIdentities>
		readonly readMergeBase: (
			range: RiskRange
		) => Effect.Effect<string, RiskStepOneError>
		readonly readFloors: (
			base: string,
			head: string,
			rules: Rules
		) => Effect.Effect<FloorReport | undefined>
		/** The commit's tree, or `undefined` when its objects do not fetch. */
		readonly readTree: (sha: string) => Effect.Effect<string | undefined>
	}
>()('mng-review/RiskReadService') {}

export const RiskReadServiceLive = Layer.effect(
	RiskReadService,
	Effect.gen(function* () {
		const risk = yield* GitHubRiskService
		const api = yield* GitHubApiService
		const reviews = yield* GitHubReviewService
		const publisher = yield* PublishService
		const git = yield* GitService
		const floorDiff = yield* FloorDiffService

		/** The statuses `owners` wrote for this number on one commit; a 404 fails too. */
		const readOwnedStatuses = (
			pullNumber: number,
			head: string,
			owners: StatusOwners
		) =>
			risk.listStatuses(head).pipe(
				Effect.map(statuses =>
					toAppRiskStatuses(head, statuses, owners, pullNumber)
				),
				Effect.mapError(
					error =>
						new RiskStepOneError({
							stage: 'held-read',
							reason: error.message,
						})
				)
			)

		const readHeadStatuses = Effect.fn('RiskReadService.readHeadStatuses')(
			function* (pullNumber: number, head: string) {
				const { current } = yield* OwnedIdentities
				return yield* readOwnedStatuses(pullNumber, head, {
					current,
					identities: [current],
				})
			}
		)

		const readHeld = Effect.fn('RiskReadService.readHeld')(function* (
			pullNumber: number,
			head: string
		) {
			const owners = getHeldOwners(yield* OwnedIdentities)
			const items = yield* risk.listTimeline(pullNumber).pipe(
				Effect.mapError(
					error =>
						new RiskStepOneError({
							stage: 'held-read',
							reason: error.message,
						})
				)
			)
			const heads = getTimelineHeads(items, head)
			if (!heads)
				return yield* new RiskStepOneError({
					stage: 'held-read',
					reason: 'the timeline lists a commit without its commit reference',
				})
			const statuses = (yield* Effect.forEach(
				heads,
				sha => readOwnedStatuses(pullNumber, sha, owners),
				{ concurrency: STATUS_READ_CONCURRENCY }
			)).flat()
			const held: StatusLevel = getStatusesHighest(statuses)
			return { items, heads, statuses, held } satisfies HeldRead
		})

		const readMarker = Effect.fn('RiskReadService.readMarker')(function* (
			pullNumber: number
		) {
			const { current } = yield* OwnedIdentities
			return yield* api.listComments(pullNumber).pipe(
				Effect.map(comments => toMarkerRead(comments, current)),
				Effect.orElseSucceed((): MarkerRead => ({ status: 'failed' }))
			)
		})

		const readEditedLevel = Effect.fn('RiskReadService.readEditedLevel')(
			function* (marker: MarkerRead) {
				const { current } = yield* OwnedIdentities
				if (marker.status !== 'trusted' && marker.status !== 'edited')
					return 'none'
				if (marker.nodeId === undefined) return undefined
				return yield* risk.readCommentEdits(marker.nodeId).pipe(
					Effect.map(edits => getEditedLevel(edits, current)),
					Effect.orElseSucceed(() => undefined)
				)
			}
		)

		const readHistory = Effect.fn('RiskReadService.readHistory')(function* (
			pullNumber: number,
			statuses: readonly AppRiskStatus[]
		) {
			const { identities } = getHeldOwners(yield* OwnedIdentities)
			return yield* reviews.listReviews(pullNumber).pipe(
				Effect.map(list => hasAppHistory(statuses, list, identities)),
				Effect.orElseSucceed(() => true)
			)
		})

		/**
		 * True when a bug thread counts as open: open on GitHub, answered by this run without closing
		 * it, or holding an unsettled answer, read whole when the windows do not show it.
		 */
		const isCounted = Effect.fn('RiskReadService.isCounted')(function* (
			thread: BotThread,
			answered: readonly string[]
		) {
			const { current } = yield* OwnedIdentities
			if (!thread.resolved || answered.includes(thread.id)) return true
			if (thread.unsettled !== undefined) return thread.unsettled
			const comments = yield* api.listThreadComments(thread.id)
			return isUnsettled(comments, current)
		})

		const readThreadBugs = Effect.fn('RiskReadService.readThreadBugs')(
			function* (pullNumber: number, answered: readonly string[]) {
				return yield* publisher.readThreads(pullNumber).pipe(
					Effect.flatMap(threads =>
						Effect.filter(
							threads.filter(
								thread =>
									thread.marker.kind === 'bug' &&
									thread.marker.confirmed === true
							),
							thread => isCounted(thread, answered),
							{ concurrency: 1 }
						)
					),
					Effect.map(threads => threads.map(thread => thread.marker.severity)),
					Effect.orElseSucceed(() => undefined),
					provideListCompleteness(true)
				)
			}
		)

		const readMergeBase = Effect.fn('RiskReadService.readMergeBase')(function* (
			range: RiskRange
		) {
			return yield* git.mergeBase(range.baseSha, range.head).pipe(
				Effect.mapError(
					error =>
						new RiskStepOneError({
							stage: 'merge-base',
							reason: error.message,
						})
				)
			)
		})

		const readFloors = Effect.fn('RiskReadService.readFloors')(function* (
			base: string,
			head: string,
			rules: Rules
		) {
			const { risk: settings } = rules.config
			return yield* floorDiff.read({ base, head }).pipe(
				Effect.map(diff =>
					getFloorReport(diff, {
						floors: settings.floors,
						assets: settings.assets,
						rulesPaths: rules.risk?.paths ?? [],
					})
				),
				Effect.orElseSucceed(() => undefined)
			)
		})

		const readTree = Effect.fn('RiskReadService.readTree')(function* (
			sha: string
		) {
			const result = yield* git
				.exec(['rev-parse', '--verify', '--end-of-options', `${sha}^{tree}`])
				.pipe(Effect.orElseSucceed(() => undefined))
			const tree = result?.stdout.trim()
			return result?.exitCode === 0 && tree ? tree : undefined
		})

		return {
			readHeld,
			readHeadStatuses,
			readMarker,
			readEditedLevel,
			readHistory,
			readThreadBugs,
			readMergeBase,
			readFloors,
			readTree,
		}
	})
)
