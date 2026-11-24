import { PERSON_TYPE } from '@mng-review/domain'
import { Context, Effect, Layer } from 'effect'
import type {
	CommentAuthor,
	ReviewThread,
	ThreadComment,
} from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubReviewService } from '../../../platform/github-review.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { ReplyNamingService } from '../../publish/application/reply-naming.service'
import { SummaryReviewService } from '../../publish/application/summary-review.service'
import {
	isBotComment,
	toBotThread,
} from '../../publish/domain/bot-thread.helper'
import type { BotThread } from '../../publish/domain/publish.types'
import { isAnswerableThread } from '../../publish/domain/thread-conversation.helper'
import type { CommentVersion } from '../domain/answer.helper'
import {
	type EntryQualifier,
	getUnnamedReplies,
	type ReplyVersion,
} from '../domain/reply-answer.helper'
import type { DispatchKind } from '../domain/sweep-dispatch.helper'
import {
	getEarliestTime,
	getHoldingComment,
	getLatestTime,
	getResolvedHolds,
	isRatedSince,
	type RatingRun,
} from '../domain/sweep-hold.helper'

/** Why a comment holds the pull request for the sweep. */
export type CandidateReason = 'reply-unanswered' | 'review-unrated'

/** The comment that holds the pull request, at the version the sweep read, and what it needs. */
export interface SweepCandidate {
	readonly reason: CandidateReason
	readonly kind: DispatchKind
	readonly comment: CommentVersion
}

/** Whether the repeat rule lets a candidate's key dispatch; a blocked one is passed over. */
export type CandidateCheck = (
	candidate: SweepCandidate
) => Effect.Effect<boolean, GitHubApiError>

/** An app thread the converse answers, read whole, with the writers among its authors. */
interface ReplyThread {
	readonly thread: BotThread
	readonly comments: readonly ThreadComment[]
	readonly writers: ReadonlySet<string>
	/** The replies that hold before the runs are read: a superset, since no entry qualifies yet. */
	readonly holds: readonly ReplyVersion[]
}

/** A review body or a writer-started thread at its holding version, with the author to check. */
interface ReviewHold {
	readonly comment: CommentVersion
	readonly author: CommentAuthor | null
}

/** Every comment that may hold the pull request, read before the runs. */
export interface SweepHolders {
	readonly replies: readonly ReplyThread[]
	/**
	 * The newest review body or thread a writer wrote. A rating run after it is after every older
	 * one too, so only it can hold, and the review dispatch is keyed by it.
	 */
	readonly review?: ReviewHold
}

/** What decides which holder still holds: the pull request's runs, as the sweep read them. */
export interface ChooseInput {
	readonly holders: SweepHolders
	readonly qualifies: EntryQualifier
	readonly rated: readonly RatingRun[]
	readonly isOpen: CandidateCheck
}

/**
 * The oldest time among the comments that may hold, the reply holds and the newest writer review
 * hold: no run created before it can name, rate or repeat-block one of them, so the runs list
 * starts there. `undefined` when nothing may hold.
 */
export function getOldestHold(holders: SweepHolders): string | undefined {
	return getEarliestTime([
		...holders.replies.flatMap(entry => entry.holds.map(hold => hold.at)),
		...(holders.review ? [holders.review.comment.at] : []),
	])
}

/**
 * The comments the sweep's dispatches answer, in two steps around the runs read: `gather` reads
 * every comment that may hold (thread replies no app answer names, and the newest review body or
 * thread a writer started) before any run is listed, so their oldest time bounds the runs list;
 * `choose` then picks the first one that still holds and the repeat rule lets through. A failed
 * read, a role read included, fails the call.
 */
export class SweepCandidateService extends Context.Service<
	SweepCandidateService,
	{
		readonly gather: (
			pullNumber: number,
			raw: readonly ReviewThread[]
		) => Effect.Effect<SweepHolders, GitHubApiError, OwnedIdentities>
		readonly choose: (
			input: ChooseInput
		) => Effect.Effect<
			SweepCandidate | undefined,
			GitHubApiError,
			OwnedIdentities
		>
	}
>()('mng-review/SweepCandidateService') {}

export const SweepCandidateServiceLive = Layer.effect(
	SweepCandidateService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const reviews = yield* GitHubReviewService
		const naming = yield* ReplyNamingService
		const summaries = yield* SummaryReviewService

		/** The app threads the converse answers that have a writer's reply no answer names. */
		const readReplies = Effect.fn('SweepCandidateService.readReplies')(
			function* (pullNumber: number, raw: readonly ReviewThread[]) {
				const owned = yield* OwnedIdentities
				const waiting = yield* summaries.readWaiting(pullNumber)
				const threads = raw.flatMap(
					thread => toBotThread(thread, owned.identities) ?? []
				)
				const found = yield* Effect.forEach(
					threads.filter(
						thread =>
							isAnswerableThread(thread, waiting, true) && thread.replies > 0
					),
					thread =>
						Effect.gen(function* () {
							const comments = yield* api.listThreadComments(thread.id)
							const writers = yield* naming.requireWriters(
								comments.flatMap(comment => comment.author?.login ?? [])
							)
							const unnamed = getUnnamedReplies(comments, owned, writers)
							const holds = thread.resolved
								? getResolvedHolds(comments, owned.identities, unnamed)
								: unnamed
							return holds.length === 0
								? []
								: [{ thread, comments, writers, holds }]
						}),
					{ concurrency: 1 }
				)
				return found.flat()
			}
		)

		/** Review bodies a person wrote, at their latest time. */
		const readBodies = Effect.fn('SweepCandidateService.readBodies')(function* (
			pullNumber: number
		) {
			const list = yield* reviews.listReviews(pullNumber)
			return list.flatMap((review): ReviewHold[] => {
				const time = getLatestTime([
					review.createdAt,
					review.submittedAt,
					review.lastEditedAt,
				])
				if (
					review.databaseId === null ||
					review.body.trim() === '' ||
					time === undefined ||
					review.author?.__typename !== PERSON_TYPE
				)
					return []
				return [
					{
						comment: { id: review.databaseId, at: time, body: review.body },
						author: review.author,
					},
				]
			})
		})

		/**
		 * Review threads a person started (not the app), held by their latest comment, edits included;
		 * past the two comment windows the whole thread is read.
		 */
		const readThreads = Effect.fn('SweepCandidateService.readThreads')(
			function* (raw: readonly ReviewThread[]) {
				const { identities } = yield* OwnedIdentities
				const found = yield* Effect.forEach(
					raw,
					thread =>
						Effect.gen(function* () {
							const [first] = thread.comments.nodes
							if (
								!first ||
								first.databaseId === null ||
								isBotComment(first, identities) ||
								first.author?.__typename !== PERSON_TYPE
							)
								return []
							const windows = [
								...thread.comments.nodes,
								...(thread.latest?.nodes ?? []),
							]
							// An edit between the first and the latest comments shows only in the whole thread.
							const holding = getHoldingComment(
								thread.comments.totalCount > windows.length
									? yield* api.listThreadComments(thread.id)
									: windows
							)
							return holding ? [{ comment: holding, author: first.author }] : []
						}),
					{ concurrency: 1 }
				)
				return found.flat()
			}
		)

		const gather = Effect.fn('SweepCandidateService.gather')(function* (
			pullNumber: number,
			raw: readonly ReviewThread[]
		) {
			const replies = yield* readReplies(pullNumber, raw)
			const holds = [
				...(yield* readBodies(pullNumber)),
				...(yield* readThreads(raw)),
			]
			// Non-writers never hold, so an old review of theirs never bounds the runs list.
			const writers = yield* naming.requireWriters(
				holds.flatMap(hold => hold.author?.login ?? [])
			)
			const review = holds
				.filter(hold => writers.has(hold.author?.login.toLowerCase() ?? ''))
				.reduce<ReviewHold | undefined>(
					(newest, hold) =>
						newest === undefined || hold.comment.at > newest.comment.at
							? hold
							: newest,
					undefined
				)
			return { replies, ...(review ? { review } : {}) } satisfies SweepHolders
		})

		/** The newest writer review hold, unless a full rating ran after it. */
		const chooseReview = Effect.fn('SweepCandidateService.chooseReview')(
			function* (input: ChooseInput) {
				const hold = input.holders.review
				if (!hold || isRatedSince(hold.comment.at, input.rated))
					return undefined
				const candidate = {
					reason: 'review-unrated',
					kind: 'review',
					comment: hold.comment,
				} satisfies SweepCandidate
				return (yield* input.isOpen(candidate)) ? candidate : undefined
			}
		)

		const choose = Effect.fn('SweepCandidateService.choose')(function* (
			input: ChooseInput
		) {
			const owned = yield* OwnedIdentities
			for (const entry of input.holders.replies) {
				// Only the current app's answers name a reply; every owned bot's answer can resolve it.
				const unnamed = getUnnamedReplies(
					entry.comments,
					owned,
					entry.writers,
					input.qualifies
				)
				const holds = entry.thread.resolved
					? getResolvedHolds(entry.comments, owned.identities, unnamed)
					: unnamed
				for (const reply of holds) {
					const candidate = {
						reason: 'reply-unanswered',
						kind: 'converse',
						comment: reply,
					} satisfies SweepCandidate
					if (yield* input.isOpen(candidate)) return candidate
				}
			}
			return yield* chooseReview(input)
		})

		return { gather, choose }
	})
)
