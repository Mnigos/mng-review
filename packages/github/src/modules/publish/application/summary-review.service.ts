import { Context, Effect, Layer } from 'effect'
import { isNotFound } from '../../../platform/github-api.helper'
import { GitHubApiService } from '../../../platform/github-api.service'
import {
	GitHubReviewService,
	REVIEW_EVENT_BY_STATE,
} from '../../../platform/github-review.service'
import { GitHubConfig } from '../../../platform/github.config'
import type { GitHubApiError } from '../../../platform/github.errors'
import { getIncompleteLists } from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import {
	type LatestHead,
	toDecidedSummary,
} from '../domain/review-event.helper'
import {
	getListedWaiting,
	getSummary,
	toSummaryComments,
} from '../domain/summary-comment.helper'
import { getMarkerError } from '../domain/summary-marker.helper'
import {
	getEditableReview,
	getPriorSummary,
	hasChangeRequest,
	toSummaryReviews,
} from '../domain/summary-review.helper'
import { toHeadedSummary } from '../presentation/review-headline.formatter'
import {
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
	SummaryCleanupService,
	SummaryCleanupServiceLive,
} from './summary-cleanup.service'
import type {
	ManualRunInput,
	SummaryDraft,
	SummaryRead,
	SummaryWriteError,
	WrittenSummary,
} from './summary-review.service.types'

/**
 * The summary as the body of the bot's review. Each run that posts threads, or whose review state
 * would change, submits one review with the summary as its body and the new inline comments; any
 * other run edits the body of the newest review. Every write hides the bot's earlier reviews and
 * old sticky comments as outdated, but that of a run whose list reads left a node out. The state the next run builds on is the marker of the newest
 * summary review of any owned identity, hidden or dismissed, or with none the old sticky comment.
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
		/** The marker of the summary a run builds on: run count and last finished head. */
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
		/** Counts a manual run in the summary before it starts; `false` at the cap, with nothing written. */
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
			} satisfies SummaryRead
		})

		const readPrior = Effect.fn('SummaryReviewService.readPrior')(function* (
			pullNumber: number
		) {
			const { current, identities } = yield* OwnedIdentities
			const reviews = toSummaryReviews(
				yield* github.listReviews(pullNumber),
				identities,
				current
			)
			const latest = reviews.at(-1)
			if (latest) return latest.marker
			const comments = yield* api.listComments(pullNumber)
			return getSummary(toSummaryComments(comments, identities, current))
				?.marker
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
		 * Edits the newest summary review when it can be edited (keeping its state), else posts one in
		 * the state `toDecidedSummary` picks; the body's headline names the state it lands in. A run
		 * whose list reads, this write's own included, left a node out never edits an approval: it
		 * posts a `COMMENT` review, so the approval is no longer the newest. It attaches no inline
		 * comment then, and its summary lists their findings and clears no wait.
		 */
		const writeReview = Effect.fn('SummaryReviewService.writeReview')(
			function* (
				pullNumber: number,
				draft: SummaryDraft,
				found: SummaryRead,
				latest: LatestHead
			) {
				const { identities } = yield* OwnedIdentities
				const changesRequested = hasChangeRequest(found.raw, identities)
				const prior = getPriorSummary(found.reviews, found.summaries)
				// The write's own read may have hidden a thread an inline comment would repeat.
				const incomplete = latest.incomplete !== undefined
				const decide = (inline: boolean) =>
					toDecidedSummary(
						draft.render(
							prior,
							inline && !incomplete,
							latest.current !== draft.head,
							incomplete
						),
						changesRequested,
						latest,
						draft.head
					)
				const fresh = draft.fresh === true || (draft.comments?.length ?? 0) > 0
				const decided = decide(true)
				const unreadable = getMarkerError(decided.rendered.marker)
				if (unreadable) return yield* unreadable
				const editable = getEditableReview(
					found.reviews,
					decided.decision,
					fresh,
					{ head: draft.head, current: latest.current }
				)
				// An incomplete run leaves no approval as the app's newest review: it posts a comment over it.
				const keptApproval = incomplete && editable?.state === 'APPROVED'
				if (editable && !keptApproval) {
					const edited = toHeadedSummary(
						decided,
						REVIEW_EVENT_BY_STATE[editable.state]
					)
					const updated = yield* github
						.updateReview(pullNumber, editable.id, edited.rendered.body)
						.pipe(
							Effect.as(true),
							Effect.catchIf(isNotFound, () => Effect.succeed(false))
						)
					if (updated)
						return {
							id: editable.id,
							...edited,
							review: { state: editable.state, commit: editable.commit },
							inline: !incomplete,
							created: false,
						}
				}
				const posted = yield* posting.post(
					pullNumber,
					incomplete ? { ...draft, comments: [] } : draft,
					toHeadedSummary(decided),
					() => toHeadedSummary(decide(false)),
					found.raw
				)
				return {
					...posted,
					inline: posted.inline && !incomplete,
					created: true,
				}
			}
		)

		/**
		 * The pull request's head, whether the token's identity opened it and whether it is open and
		 * not a draft, read again; a failed read leaves the head and the state unknown, never a draft.
		 * It also names the lists a read of the run so far left a node out of (`getIncompleteLists`).
		 */
		const readHead = Effect.fn('SummaryReviewService.readHead')(function* (
			pullNumber: number
		) {
			const { current } = yield* OwnedIdentities
			const pr = yield* api
				.getPullRequest(pullNumber)
				.pipe(Effect.orElseSucceed(() => undefined))
			const lists = yield* getIncompleteLists
			return {
				current: pr?.head.sha,
				authored: pr?.user?.login.toLowerCase() === current.restLogin,
				...(pr ? { open: pr.state === 'open' && pr.draft !== true } : {}),
				...(lists.length > 0 ? { incomplete: lists } : {}),
			} satisfies LatestHead
		})

		/**
		 * Reads the head right before the review write, which decides against it, again before the
		 * cleanup and once more before the dismissals, so a push that lands meanwhile keeps the state.
		 * The dismissal API takes no expected head, so the last read narrows that window but cannot
		 * close it.
		 */
		const write = Effect.fn('SummaryReviewService.write')(function* (
			pullNumber: number,
			draft: SummaryDraft
		) {
			const found = yield* read(pullNumber, true)
			const before = yield* readHead(pullNumber)
			const written = yield* writeReview(pullNumber, draft, found, before)
			const cleanup = yield* cleanups.cleanUp(found, written.id, {
				head: draft.head,
				current: (yield* readHead(pullNumber)).current,
			})
			const { outlived, ...dismissal } = yield* dismissals.dismissStale(
				pullNumber,
				{ head: draft.head, current: (yield* readHead(pullNumber)).current },
				found.raw,
				written
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
		 * the run's own write edits or hides. It hides nothing itself.
		 */
		const reserveManualRun = Effect.fn('SummaryReviewService.reserveManualRun')(
			function* (input: ManualRunInput) {
				const found = yield* read(input.pullNumber, false)
				const prior = getPriorSummary(found.reviews, found.summaries)
				if ((prior?.marker.manualRuns ?? 0) >= input.maxRuns) return false
				const latest = found.reviews.at(-1)
				if (latest?.mine) {
					const { body } = toReservedSummary(latest)
					yield* github.updateReview(input.pullNumber, latest.id, body)
					return true
				}
				if (!latest && prior?.mine) {
					yield* api.updateIssueComment(prior.id, toReservedSummary(prior).body)
					return true
				}
				const status = toReservedStatus(
					prior?.marker,
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
			ReviewPostServiceLive
		)
	)
)
