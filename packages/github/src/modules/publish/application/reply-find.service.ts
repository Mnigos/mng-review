import { commitShaSchema } from '@mng-review/domain'
import { Context, Effect, Layer, Option, Result, Schema } from 'effect'
import type { OpenPullRequest } from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubStatusService } from '../../../platform/github-status.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { getOwnerWaiting, toBotThread } from '../domain/bot-thread.helper'
import type { BotThread, OwnerWaits } from '../domain/publish.types'
import { getPendingReply } from '../domain/thread-conversation.helper'
import { getRotated } from '../domain/thread-recheck.helper'
import type { PendingReply } from '../domain/thread-reply.schema'
import { SummaryReviewService } from './summary-review.service'
import {
	ThreadReplyService,
	ThreadReplyServiceLive,
} from './thread-reply.service'

const isCommitSha = Schema.is(commitShaSchema)

/** How many pull requests one tick answers, and the tick's number, which shifts the batch. */
export interface ReplyFindInput {
	readonly max: number
	/** Shifts the batch when more pull requests wait than `max`: the workflow's run number. */
	readonly rotation: number
}

/** A pull request with a reply waiting, as the later jobs take it: its number and both commits. */
export interface ReplyCandidate {
	readonly number: number
	readonly base: string
	readonly head: string
}

/** What one tick found: the candidates to answer, and how many pull requests were read and failed. */
export interface ReplyFindResult {
	readonly candidates: readonly ReplyCandidate[]
	/** Open, same-repository pull requests whose threads were read. */
	readonly read: number
	/** Those whose read failed and were skipped. */
	readonly failed: number
}

/** The pull request whose replies to read, and the batch shift `collect` uses. */
export interface ReplyPendingInput {
	readonly pullNumber: number
	readonly rotation: number
	/** A dispatched converse's reply: a resolved thread holding it is read as if open. */
	readonly held?: number
	/** With a rating: older unnamed replies count too (`ReplyCollectInput.naming`). */
	readonly naming?: boolean
}

/** The bot's threads, oldest latest comment first, and the replies in them worth a decision. */
export interface ReplyPending {
	readonly threads: readonly BotThread[]
	readonly replies: readonly PendingReply[]
}

/** A candidate with the `databaseId` of its oldest waiting reply, which orders the candidates. */
interface FoundCandidate {
	readonly candidate: ReplyCandidate
	readonly oldest: number
}

/**
 * The open pull request as a candidate, or `undefined` for a draft, a fork, or commits that are not
 * full SHAs, since they reach a workflow matrix.
 */
function toCandidate(pr: OpenPullRequest): ReplyCandidate | undefined {
	if (
		pr.draft === true ||
		pr.head.repo?.full_name !== pr.base.repo.full_name ||
		!Number.isSafeInteger(pr.number) ||
		!isCommitSha(pr.base.sha) ||
		!isCommitSha(pr.head.sha)
	)
		return undefined
	return { number: pr.number, base: pr.base.sha, head: pr.head.sha }
}

/**
 * Finds the open pull requests of this repository where an author's reply in the bot's threads
 * waits for an answer (`ThreadReplyService.collect`: a reply by a login with write access, not in a
 * thread that waits for the owner). It calls no model and writes nothing. Drafts and forks are left
 * out, and a pull request whose read fails is skipped and counted. At most `max` are kept, oldest
 * reply first (by comment id), and when more wait the batch shifts with `rotation`, so a pull
 * request whose reply keeps failing never holds the others back. `readPending` is the per pull
 * request read the find step and the schedule's prepare step share.
 */
export class ReplyFindService extends Context.Service<
	ReplyFindService,
	{
		readonly find: (
			input: ReplyFindInput
		) => Effect.Effect<ReplyFindResult, GitHubApiError, OwnedIdentities>
		/**
		 * The bot's threads and the replies worth a decision. The threads come first; only when one
		 * holds a reply that may count (`getPendingReply` with nothing waiting) are the summaries and
		 * the bot's `needs-owner` answers read for the waiting list, the same sources publishing
		 * uses, and the authors' roles looked up.
		 */
		readonly readPending: (
			input: ReplyPendingInput
		) => Effect.Effect<ReplyPending, GitHubApiError, OwnedIdentities>
	}
>()('mng-review/ReplyFindService') {}

export const ReplyFindServiceLive = Layer.effect(
	ReplyFindService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const github = yield* GitHubStatusService
		const summaries = yield* SummaryReviewService
		const conversation = yield* ThreadReplyService

		const readPending = Effect.fn('ReplyFindService.readPending')(function* (
			input: ReplyPendingInput
		) {
			const { identities } = yield* OwnedIdentities
			const raw = yield* api.listReviewThreads(input.pullNumber)
			// Oldest latest comment first: `collect` keeps the first counting replies of one batch, so
			// with no rotation its oldest is the pull request's oldest counting reply.
			const threads = raw
				.flatMap(thread => toBotThread(thread, identities) ?? [])
				.toSorted(
					(a, b) =>
						(a.latestCommentId ?? Number.MAX_SAFE_INTEGER) -
						(b.latestCommentId ?? Number.MAX_SAFE_INTEGER)
				)
			const open = new Set(
				threads
					.filter(thread => getPendingReply(thread, []) !== undefined)
					.map(thread => thread.id)
			)
			// With naming an older unnamed reply, or a dispatched one, may wait behind an app answer.
			if (open.size === 0 && !input.naming && input.held === undefined)
				return { threads, replies: [] }
			const candidates = raw.filter(thread => open.has(thread.id))
			// A failed whole-thread read holds every longer owner thread for this read, as at publish.
			const waits = yield* conversation.getSentToOwner(candidates).pipe(
				Effect.map((sent): OwnerWaits => ({ sent, held: [] })),
				Effect.orElseSucceed(() => getOwnerWaiting(candidates, identities))
			)
			const waiting = [
				...new Set([
					...(yield* summaries.readWaiting(input.pullNumber)),
					...waits.sent,
					...waits.held,
				]),
			]
			const replies = yield* conversation.collect({
				pullNumber: input.pullNumber,
				threads,
				rotation: input.rotation,
				waiting,
				...(input.held === undefined ? {} : { held: input.held }),
				...(input.naming ? { naming: true } : {}),
			})
			return { threads, replies }
		})

		/** The candidate with its oldest waiting reply, or none when no reply counts. */
		const findOne = Effect.fn('ReplyFindService.findOne')(function* (
			candidate: ReplyCandidate
		) {
			const { replies } = yield* readPending({
				pullNumber: candidate.number,
				rotation: 0,
			})
			if (replies.length === 0) return Option.none<FoundCandidate>()
			return Option.some({
				candidate,
				oldest: Math.min(...replies.map(reply => reply.commentId)),
			} satisfies FoundCandidate)
		})

		const find = Effect.fn('ReplyFindService.find')(function* (
			input: ReplyFindInput
		) {
			const candidates = (yield* github.listOpenPullRequests()).flatMap(
				pr => toCandidate(pr) ?? []
			)
			const found = yield* Effect.forEach(
				candidates,
				candidate => Effect.result(findOne(candidate)),
				{ concurrency: 1 }
			)
			const ordered = found
				.flatMap(entry =>
					Result.isSuccess(entry) ? Option.toArray(entry.success) : []
				)
				.toSorted((a, b) => a.oldest - b.oldest)
			return {
				candidates: getRotated(ordered, input.rotation, input.max)
					.slice(0, input.max)
					.map(entry => entry.candidate),
				read: candidates.length,
				failed: found.filter(Result.isFailure).length,
			} satisfies ReplyFindResult
		})

		return { find, readPending }
	})
).pipe(Layer.provide(ThreadReplyServiceLive))
