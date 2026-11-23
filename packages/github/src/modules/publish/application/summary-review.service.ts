import { Context, Effect, Layer, Result } from 'effect'
import { isIdentity } from '../../../platform/bot-identity.helper'
import { isDeclined, isTransient } from '../../../platform/github-api.helper'
import type {
	PullRequestComment,
	PullRequestReview,
} from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import {
	GitHubReviewService,
	type InlineComment,
	REVIEW_STATE_BY_EVENT,
	type ReviewInput,
} from '../../../platform/github-review.service'
import { GitHubConfig } from '../../../platform/github.config'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { isRefused } from '../domain/bot-thread.helper'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import type {
	RenderedSummary,
	SummaryCleanup,
	SummaryComment,
	SummaryReview,
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
	getStaleReviews,
	toSummaryReviews,
} from '../domain/summary-review.helper'
import {
	toOfflineSummary,
	toReservedStatus,
	toReservedSummary,
} from '../presentation/summary-status.formatter'
import { toBlobLinks } from '../presentation/thread-comment.formatter'
import type { PublishTarget, StatusInput } from './publish.service.types'

const NOT_FOUND_STATUS = 404

/**
 * What a write left: the summary written, whether it is a review this write created, whether the
 * draft's inline comments went into it, and what became of earlier reviews and sticky comments.
 */
export interface WrittenSummary extends RenderedSummary {
	readonly cleanup: SummaryCleanup
	readonly created: boolean
	/** `false` when GitHub refused the inline comments and the body lists their findings instead. */
	readonly inline: boolean
}

/** A manual run to count before the endpoint is used. */
export interface ManualRunInput extends PublishTarget {
	/** `commands.max_runs` at the reviewed base. */
	readonly maxRuns: number
	/** The handle commands mention; a status review the reservation creates names it in a code span. */
	readonly handle: string
}

/**
 * Builds the summary over the one read just before the write; `undefined` when there is none.
 * `inline` is `false` when GitHub refused the inline comments, whose findings the body then lists.
 */
export type SummaryRender = (
	current: SummaryComment | undefined,
	inline: boolean
) => RenderedSummary

/** One run's review: the summary, the run's new inline comments and whether it posted threads. */
export interface SummaryDraft {
	/** The commit the review and its comments are on. */
	readonly head: string
	readonly render: SummaryRender
	readonly comments?: readonly InlineComment[]
	/** The run posted threads of its own, inline or on a file, so the summary is a new review. */
	readonly fresh?: boolean
}

/** The pull request's reviews and conversation comments, and the summaries among them. */
interface SummaryRead {
	readonly raw: readonly PullRequestReview[]
	readonly comments: readonly PullRequestComment[]
	readonly reviews: readonly SummaryReview[]
	readonly summaries: readonly SummaryComment[]
}

/** A review this write posted: its id, the summary it holds and whether its comments went in. */
interface PostedReview {
	readonly id: number
	readonly rendered: RenderedSummary
	readonly inline: boolean
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
		 * Posts the run's review with its inline comments. When GitHub refuses one of them (422), the
		 * summary is rendered again with their findings in the body and posted with no comments.
		 */
		const post = Effect.fn('SummaryReviewService.post')(function* (
			pullNumber: number,
			draft: SummaryDraft,
			prior: SummaryComment | undefined,
			before: readonly PullRequestReview[]
		) {
			const comments = draft.comments ?? []
			const rendered = draft.render(prior, true)
			const review = {
				commitId: draft.head,
				event: 'COMMENT',
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
			const fallback = draft.render(prior, false)
			const id = yield* create(
				pullNumber,
				{ ...review, body: fallback.body, comments: [] },
				before
			)
			return { id, rendered: fallback, inline: false } satisfies PostedReview
		})

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

		const write = Effect.fn('SummaryReviewService.write')(function* (
			pullNumber: number,
			draft: SummaryDraft
		) {
			const summaries = yield* read(pullNumber)
			const prior = getPriorSummary(summaries.reviews, summaries.summaries)
			const fresh = draft.fresh === true || (draft.comments?.length ?? 0) > 0
			const editable = getEditableReview(
				summaries.reviews,
				REVIEW_STATE_BY_EVENT.COMMENT,
				fresh
			)
			if (editable) {
				const rendered = draft.render(prior, true)
				const updated = yield* github
					.updateReview(pullNumber, editable.id, rendered.body)
					.pipe(
						Effect.as(true),
						Effect.catchIf(isNotFound, () => Effect.succeed(false))
					)
				if (updated)
					return {
						...rendered,
						inline: true,
						created: false,
						cleanup: yield* cleanUp(summaries, editable.id),
					} satisfies WrittenSummary
			}
			const posted = yield* post(pullNumber, draft, prior, summaries.raw)
			return {
				...posted.rendered,
				inline: posted.inline,
				created: true,
				cleanup: yield* cleanUp(summaries, posted.id),
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
