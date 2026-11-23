import { Context, Effect, Layer, Result } from 'effect'
import { isIdentity } from '../../../platform/bot-identity.helper'
import { isDeclined, isTransient } from '../../../platform/github-api.helper'
import type { PullRequestReview } from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import {
	GitHubReviewService,
	REVIEW_STATE_BY_EVENT,
	type ReviewInput,
} from '../../../platform/github-review.service'
import { GitHubConfig } from '../../../platform/github.config'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { toCodeSpan } from '../../../utils/markdown.util'
import { isRefused } from '../domain/bot-thread.helper'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import type {
	RenderedSummary,
	SummaryCleanup,
	SummaryComment,
} from '../domain/publish.types'
import {
	getListedWaiting,
	getSummary,
	toSummaryCleanup,
	toSummaryComments,
} from '../domain/summary-comment.helper'
import {
	getEditableReview,
	getPriorSummary,
	getStaleChangeRequests,
	getStaleReviews,
	toSummaryReviews,
} from '../domain/summary-review.helper'
import {
	toOfflineSummary,
	toReservedStatus,
	toReservedSummary,
} from '../presentation/summary-status.formatter'
import { toBlobLinks } from '../presentation/thread-comment.formatter'
import type { StatusInput } from './publish.service.types'
import type {
	ManualRunInput,
	PostedReview,
	SummaryDraft,
	SummaryRead,
	WrittenSummary,
} from './summary-review.service.types'

const NOT_FOUND_STATUS = 404

/** The reason a stale change request is dismissed with: fixed text and the head, never model output. */
function toDismissMessage(head: string): string {
	return `MNG Review no longer finds an open bug thread or a thread waiting for the owner at ${toCodeSpan(head)}.`
}

/** Leaves a review or comment visible on a failure, retried on the next write. */
const keepOnFailure = Effect.orElseSucceed((): SummaryCleanup => 'kept')

/** True when GitHub answered that the comment or review does not exist. */
function isNotFound(error: GitHubApiError): boolean {
	return error.status === NOT_FOUND_STATUS
}

/**
 * The summary as the body of the bot's review. Each run that posts threads, or whose review state
 * would change, submits one review with the summary as its body and the new inline comments; any
 * other run edits the body of the newest review. Every write hides the bot's earlier reviews and
 * old sticky comments as outdated. The state the next run builds on is the marker of the newest
 * summary review of any owned identity, hidden or dismissed, or with none the old sticky comment.
 */
export class SummaryReviewService extends Context.Service<
	SummaryReviewService,
	{
		readonly write: (
			pullNumber: number,
			draft: SummaryDraft
		) => Effect.Effect<WrittenSummary, GitHubApiError, OwnedIdentities>
		/**
		 * The offline path: the newest summary keeps its text with the marker set to unfinished, or
		 * with none a status review. `true` when the write created a review.
		 */
		readonly publishStatus: (
			input: StatusInput
		) => Effect.Effect<boolean, GitHubApiError, OwnedIdentities>
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
		const config = yield* GitHubConfig

		const read = Effect.fn('SummaryReviewService.read')(function* (
			pullNumber: number
		) {
			const { current, identities } = yield* OwnedIdentities
			const raw = yield* github.listReviews(pullNumber)
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
		 * Submits a review. A create with no answer or a 5xx is checked by a read: a review of the
		 * current identity that was not in `before` and has this body is taken as this one.
		 */
		const create = Effect.fn('SummaryReviewService.create')(function* (
			pullNumber: number,
			input: ReviewInput,
			before: readonly PullRequestReview[]
		) {
			const created = yield* Effect.result(
				github.createReview(pullNumber, input)
			)
			if (Result.isSuccess(created)) return created.success
			if (!isTransient(created.failure)) return yield* created.failure
			const { current } = yield* OwnedIdentities
			const known = new Set(before.map(review => review.databaseId))
			const own = (yield* github.listReviews(pullNumber)).findLast(
				review =>
					!known.has(review.databaseId) &&
					isIdentity(review.author, current) &&
					review.body === input.body
			)
			if (own?.databaseId === null || own?.databaseId === undefined)
				return yield* created.failure
			return own.databaseId
		})

		/**
		 * Posts the run's review with its inline comments and the rendered state, `COMMENT` when the
		 * render keeps the state. When GitHub refuses one comment (422), the summary is rendered again
		 * with their findings in the body and posted with no comments.
		 */
		const post = Effect.fn('SummaryReviewService.post')(function* (
			pullNumber: number,
			draft: SummaryDraft,
			rendered: RenderedSummary,
			retry: () => RenderedSummary,
			before: readonly PullRequestReview[]
		) {
			const comments = draft.comments ?? []
			const review = {
				commitId: draft.head,
				event: rendered.event ?? 'COMMENT',
				body: rendered.body,
				comments,
			} satisfies ReviewInput
			const first = yield* Effect.result(create(pullNumber, review, before))
			if (Result.isSuccess(first))
				return {
					id: first.success,
					rendered,
					inline: true,
				} satisfies PostedReview
			if (comments.length === 0 || !isRefused(first.failure))
				return yield* first.failure
			const fallback = retry()
			const id = yield* create(
				pullNumber,
				{
					...review,
					event: fallback.event ?? 'COMMENT',
					body: fallback.body,
					comments: [],
				},
				before
			)
			return { id, rendered: fallback, inline: false } satisfies PostedReview
		})

		/**
		 * Dismisses the owned change requests the run's review leaves stale
		 * (`getStaleChangeRequests`); one GitHub refuses stays for the next write. The count dismissed.
		 */
		const dismissStale = Effect.fn('SummaryReviewService.dismissStale')(
			function* (
				pullNumber: number,
				head: string,
				found: SummaryRead,
				event: RenderedSummary['event']
			) {
				const { current, identities } = yield* OwnedIdentities
				const dismissed = yield* Effect.forEach(
					getStaleChangeRequests(found.raw, identities, current, event),
					id =>
						github.dismissReview(pullNumber, id, toDismissMessage(head)).pipe(
							Effect.as(true),
							Effect.orElseSucceed(() => false)
						),
					{ concurrency: 1 }
				)
				return dismissed.filter(Boolean).length
			}
		)

		/** Hides an old sticky comment, deleting it only when GitHub refuses to hide it. */
		const hideComment = (summary: SummaryComment) =>
			api.minimizeComment(summary.nodeId).pipe(
				Effect.as<SummaryCleanup>('minimized'),
				Effect.catchIf(isDeclined, () =>
					api.deleteIssueComment(summary.id).pipe(
						Effect.catchIf(isNotFound, () => Effect.void),
						Effect.as<SummaryCleanup>('deleted'),
						keepOnFailure
					)
				),
				keepOnFailure
			)

		/**
		 * Hides every earlier review of an owned identity and every old sticky comment as outdated. A
		 * submitted review cannot be deleted, so one GitHub refuses to hide stays `kept`; the next
		 * write tries again.
		 */
		const cleanUp = Effect.fn('SummaryReviewService.cleanUp')(function* (
			found: SummaryRead,
			kept: number
		) {
			const { identities } = yield* OwnedIdentities
			const reviews = yield* Effect.forEach(
				getStaleReviews(found.raw, identities, kept),
				review =>
					api
						.minimizeComment(review.id)
						.pipe(Effect.as<SummaryCleanup>('minimized'), keepOnFailure),
				{ concurrency: 1 }
			)
			const comments = yield* Effect.forEach(found.summaries, hideComment, {
				concurrency: 1,
			})
			return toSummaryCleanup([...reviews, ...comments])
		})

		/** Edits the newest summary review when it can be edited, else posts a new review. */
		const writeReview = Effect.fn('SummaryReviewService.writeReview')(
			function* (pullNumber: number, draft: SummaryDraft, found: SummaryRead) {
				const prior = getPriorSummary(found.reviews, found.summaries)
				const fresh = draft.fresh === true || (draft.comments?.length ?? 0) > 0
				const rendered = draft.render(prior, true)
				const editable = getEditableReview(
					found.reviews,
					rendered.event && REVIEW_STATE_BY_EVENT[rendered.event],
					fresh
				)
				if (editable) {
					const updated = yield* github
						.updateReview(pullNumber, editable.id, rendered.body)
						.pipe(
							Effect.as(true),
							Effect.catchIf(isNotFound, () => Effect.succeed(false))
						)
					if (updated)
						return {
							id: editable.id,
							rendered,
							inline: true,
							created: false,
						}
				}
				const posted = yield* post(
					pullNumber,
					draft,
					rendered,
					() => draft.render(prior, false),
					found.raw
				)
				return { ...posted, created: true }
			}
		)

		const write = Effect.fn('SummaryReviewService.write')(function* (
			pullNumber: number,
			draft: SummaryDraft
		) {
			const found = yield* read(pullNumber)
			const written = yield* writeReview(pullNumber, draft, found)
			return {
				...written.rendered,
				inline: written.inline,
				created: written.created,
				cleanup: yield* cleanUp(found, written.id),
				dismissed: yield* dismissStale(
					pullNumber,
					draft.head,
					found,
					written.rendered.event
				),
			} satisfies WrittenSummary
		})

		const publishStatus = Effect.fn('SummaryReviewService.publishStatus')(
			function* (input: StatusInput) {
				const links = toBlobLinks(config, input)
				const written = yield* write(input.pullNumber, {
					head: input.head,
					render: current => toOfflineSummary(current, input.status, links),
				})
				return written.created
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
				const found = yield* read(input.pullNumber)
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
				yield* create(
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
)
