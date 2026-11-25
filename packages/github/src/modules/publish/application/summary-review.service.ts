import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import {
	GitHubReviewService,
	REVIEW_EVENT_BY_STATE,
} from '../../../platform/github-review.service'
import { GitHubConfig } from '../../../platform/github.config'
import type { GitHubApiError } from '../../../platform/github.errors'
import {
	isReadIncomplete,
	readListed,
} from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import {
	getListedWaiting,
	toHiddenSummaryComments,
	toSummaryComments,
} from '../domain/summary-comment.helper'
import { isManualRunCapped } from '../domain/summary-marker.helper'
import {
	getPriorMarker,
	getPriorSummary,
	toSummaryReviews,
} from '../domain/summary-review.helper'
import {
	toIncompleteSummary,
	toOfflineSummary,
	toReservedStatus,
	toReservedSummary,
} from '../presentation/summary-status.formatter'
import { toBlobLinks } from '../presentation/thread-comment.formatter'
import type { StatusInput } from './publish.service.types'
import {
	ReviewDismissService,
	ReviewDismissServiceLive,
} from './review-dismiss.service'
import { ReviewPostService, ReviewPostServiceLive } from './review-post.service'
import {
	ReviewWriteService,
	ReviewWriteServiceLive,
} from './review-write.service'
import {
	SummaryCleanupService,
	SummaryCleanupServiceLive,
} from './summary-cleanup.service'
import type {
	ManualRunInput,
	SummaryDraft,
	SummaryRead,
	SummaryRender,
	SummaryWriteError,
	WrittenSummary,
} from './summary-review.service.types'

/**
 * The summary as the body of the bot's review. Each run that posts threads, or whose review state
 * would change, submits one review with the summary as its body and the new inline comments; any
 * other run edits the body of the newest review (`ReviewWriteService`). Every write hides earlier summaries, the bot's
 * reviews and old sticky comments, as outdated, but not when a list read of the run left a node
 * out. The state the next run builds on is the marker of the newest summary review of any owned
 * identity, hidden or dismissed, or with none the old sticky comment.
 */
export class SummaryReviewService extends Context.Service<
	SummaryReviewService,
	{
		readonly write: (
			pullNumber: number,
			draft: SummaryDraft
		) => Effect.Effect<WrittenSummary, SummaryWriteError, OwnedIdentities>
		/**
		 * The offline path: the newest summary keeps its text with the marker set to unfinished, or
		 * with none a status review; the state stays.
		 */
		readonly publishStatus: (
			input: StatusInput
		) => Effect.Effect<WrittenSummary, SummaryWriteError, OwnedIdentities>
		/**
		 * The marker of the summary a run builds on: run count and last finished head. Its counts are
		 * the most any listed summary holds, reviews and sticky comments alike, hidden ones included,
		 * so they never fall below what the summaries a read lists hold. A write that cannot see the
		 * summary with the higher count stores a lower one, so the run caps can undercount until that
		 * summary is listed again; the caps bound cost, not approval.
		 */
		readonly readPrior: (
			pullNumber: number
		) => Effect.Effect<
			SummaryMarker | undefined,
			GitHubApiError,
			OwnedIdentities
		>
		/** The threads every owned summary lists as waiting for the owner, hidden ones included (`getListedWaiting`). */
		readonly readWaiting: (
			pullNumber: number
		) => Effect.Effect<readonly string[], GitHubApiError, OwnedIdentities>
		/**
		 * Counts a manual run in the summary before it starts; `false` at the cap, or once a list read
		 * of the run left a node out, which may hide the marker that holds the count, with nothing
		 * written.
		 */
		readonly reserveManualRun: (
			input: ManualRunInput
		) => Effect.Effect<boolean, GitHubApiError, OwnedIdentities>
	}
>()('mng-review/SummaryReviewService') {}

export const SummaryReviewServiceLive = Layer.effect(
	SummaryReviewService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const github = yield* GitHubReviewService
		const dismissals = yield* ReviewDismissService
		const posting = yield* ReviewPostService
		const writes = yield* ReviewWriteService
		const cleanups = yield* SummaryCleanupService
		const config = yield* GitHubConfig

		const read = Effect.fn('SummaryReviewService.read')(function* (
			pullNumber: number,
			withCommits: boolean
		) {
			const { current, identities } = yield* OwnedIdentities
			const raw = yield* github.listReviews(pullNumber, withCommits)
			const comments = yield* api.listComments(pullNumber)
			return {
				raw,
				comments,
				reviews: toSummaryReviews(raw, identities, current),
				summaries: toSummaryComments(comments, identities, current),
				hidden: toHiddenSummaryComments(comments, identities, current),
			} satisfies SummaryRead
		})

		const readPrior = Effect.fn('SummaryReviewService.readPrior')(function* (
			pullNumber: number
		) {
			const found = yield* read(pullNumber, false)
			return getPriorMarker(found.reviews, found.summaries, found.hidden)
		})

		const readWaiting = Effect.fn('SummaryReviewService.readWaiting')(
			function* (pullNumber: number) {
				const { identities } = yield* OwnedIdentities
				const reviews = yield* github.listReviews(pullNumber)
				const comments = yield* api.listComments(pullNumber)
				return getListedWaiting([...reviews, ...comments], identities)
			}
		)

		/**
		 * Reads the head right before the review write, which decides against it, again before the
		 * cleanup and once more before the dismissals, so a push that lands meanwhile keeps the state.
		 * The dismissal API takes no expected head, so the last read narrows that window but cannot
		 * close it. When a list read of the run left a node out, that node may be a newer summary the
		 * marker should build on, or something the run's verdict missed, so the summary is still
		 * written, this run's findings in it, but its marker is unfinished and failed
		 * (`toIncompleteSummary`); when the write's own read left it out, the summary is a new review.
		 */
		const write = Effect.fn('SummaryReviewService.write')(function* (
			pullNumber: number,
			draft: SummaryDraft
		) {
			const listed = yield* readListed(read(pullNumber, true))
			const found = listed.incomplete
				? { ...listed.value, incomplete: true }
				: listed.value
			const render: SummaryRender = (...args) =>
				toIncompleteSummary(draft.render(...args))
			// Only a run whose reads were all complete releases the hold an unfinished marker keeps.
			const unfinished = yield* isReadIncomplete
			const written = yield* writes.write(
				pullNumber,
				unfinished ? { ...draft, render } : draft,
				found,
				yield* writes.readHead(pullNumber)
			)
			const cleanup = yield* cleanups.cleanUp(found, written.id, {
				head: draft.head,
				current: (yield* writes.readHead(pullNumber)).current,
			})
			const { outlived, ...dismissal } = yield* dismissals.dismissStale(
				pullNumber,
				{
					head: draft.head,
					current: (yield* writes.readHead(pullNumber)).current,
				},
				found.raw,
				{ ...written, evidence: written.rendered.evidence }
			)
			return {
				...written.rendered,
				event: REVIEW_EVENT_BY_STATE[written.review.state],
				inline: written.inline,
				created: written.created,
				cleanup,
				dismissal,
				outlived,
			} satisfies WrittenSummary
		})

		const publishStatus = Effect.fn('SummaryReviewService.publishStatus')(
			function* (input: StatusInput) {
				const links = toBlobLinks(config, input)
				return yield* write(input.pullNumber, {
					head: input.head,
					render: current => toOfflineSummary(current, input.status, links),
				})
			}
		)

		/**
		 * Counts a manual run in the marker of the summary a run builds on, before the endpoint is
		 * used, so a run that fails later still counts: the newest summary review's marker when the
		 * current identity wrote it, hidden or not; with no review, the current identity's old sticky
		 * comment; otherwise a `COMMENT` review with one status line over the carried marker, which
		 * the run's own write edits or hides. It hides nothing itself, and counts nothing once a list
		 * read of the run left a node out. Past the cap it still counts a full review while the newest
		 * marker is unfinished (`isManualRunCapped`).
		 */
		const reserveManualRun = Effect.fn('SummaryReviewService.reserveManualRun')(
			function* (input: ManualRunInput) {
				const found = yield* read(input.pullNumber, false)
				// A node left out may be the only marker that counts the runs so far.
				if (yield* isReadIncomplete) return false
				// Its counts are the most any listed summary holds, hidden ones included.
				const prior = getPriorSummary(
					found.reviews,
					found.summaries,
					found.hidden
				)
				const counted = getPriorMarker(
					found.reviews,
					found.summaries,
					found.hidden
				)
				if (isManualRunCapped(counted, input.maxRuns, input.agent)) return false
				const latest = found.reviews.at(-1)
				if (latest?.mine && prior) {
					const { body } = toReservedSummary(prior)
					yield* github.updateReview(input.pullNumber, latest.id, body)
					return true
				}
				if (!latest && prior?.mine) {
					yield* api.updateIssueComment(prior.id, toReservedSummary(prior).body)
					return true
				}
				const status = toReservedStatus(
					counted,
					input.handle,
					toBlobLinks(config, input)
				)
				yield* posting.create(
					input.pullNumber,
					{
						commitId: input.head,
						event: 'COMMENT',
						body: status.body,
						comments: [],
					},
					found.raw
				)
				return true
			}
		)

		return {
			write,
			publishStatus,
			readPrior,
			readWaiting,
			reserveManualRun,
		}
	})
).pipe(
	Layer.provide(
		Layer.mergeAll(
			ReviewDismissServiceLive,
			SummaryCleanupServiceLive,
			ReviewPostServiceLive,
			ReviewWriteServiceLive
		)
	)
)
