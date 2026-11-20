import { Context, Effect, Layer, Option } from 'effect'
import type { CollaboratorRole } from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { hasWriteAccess } from '../../command/domain/command-access.helper'
import { toBodyDigest } from '../domain/bot-thread.helper'
import { MAX_REPLY_CHARS, MAX_REPLY_THREADS } from '../domain/publish.constants'
import type { AppliedReply, BotThread } from '../domain/publish.types'
import {
	countDisputes,
	getApplicableReplies,
	getPendingReply,
	type ReplyRef,
} from '../domain/thread-conversation.helper'
import { getRotated } from '../domain/thread-recheck.helper'
import type {
	DecidedThreadReply,
	PendingReply,
} from '../domain/thread-reply.schema'
import type { BlobLinks } from '../presentation/thread-comment.formatter'
import { formatReplyAnswer } from '../presentation/thread-reply.formatter'

/** Answers after which the bot also asks GitHub to resolve the thread. */
const CLOSING_ACTIONS: ReadonlySet<string> = new Set(['resolved', 'accepted'])

/** What the prepare step collects replies from. */
export interface ReplyCollectInput {
	readonly pullNumber: number
	/** The bot's threads, read before. */
	readonly threads: readonly BotThread[]
	/** Shifts the batch when more than `MAX_REPLY_THREADS` replies wait: the run count. */
	readonly rotation: number
}

/** The review's decisions and the publisher's fresh read of the bot's threads. */
export interface ReplyApplyInput {
	readonly links: BlobLinks
	readonly decisions: readonly DecidedThreadReply[]
	readonly threads: readonly BotThread[]
}

/** A pending reply found in a thread, before its comments are read. */
interface PendingThread {
	readonly thread: BotThread
	readonly ref: ReplyRef
}

/**
 * The author's side of the bot's threads. `collect` finds the replies worth a decision before any
 * model call; `apply` writes the review's decisions after publishing's own read. A GitHub error
 * never fails a call: a reply that cannot be checked does not count, a failed write leaves its
 * thread as it was.
 */
export class ThreadReplyService extends Context.Service<
	ThreadReplyService,
	{
		/**
		 * Replies whose author has write access (`getCollaboratorRole`), at most `MAX_REPLY_THREADS`,
		 * a different batch each run when there are more, each with the bot's earlier disputes.
		 */
		readonly collect: (
			input: ReplyCollectInput
		) => Effect.Effect<readonly PendingReply[], never, OwnedIdentities>
		/**
		 * Answers each decision that still holds (`getApplicableReplies`) and whose reply's author
		 * still has write access, and tries to resolve a thread it closes; a failed answer leaves the
		 * thread out of the result.
		 */
		readonly apply: (
			input: ReplyApplyInput
		) => Effect.Effect<readonly AppliedReply[]>
	}
>()('mng-review/ThreadReplyService') {}

export const ThreadReplyServiceLive = Layer.effect(
	ThreadReplyService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService

		/** A login's access, or `undefined` when GitHub does not answer. */
		const readRole = Effect.fn('ThreadReplyService.readRole')(function* (
			login: string
		) {
			return yield* api.getCollaboratorRole(login).pipe(
				Effect.map((access): CollaboratorRole | undefined => access),
				Effect.orElseSucceed(() => undefined)
			)
		})

		/** The logins, lowercased, that have write access; one lookup per login, a failed one counts as none. */
		const getWriters = Effect.fn('ThreadReplyService.getWriters')(function* (
			logins: readonly string[]
		) {
			const distinct = [...new Set(logins.map(login => login.toLowerCase()))]
			const writers = yield* Effect.filter(
				distinct,
				login =>
					readRole(login).pipe(
						Effect.map(access => access !== undefined && hasWriteAccess(access))
					),
				{ concurrency: 1 }
			)
			return new Set(writers)
		})

		/** The reply as the thread's comments show it now; none once another comment followed it. */
		const readReply = Effect.fn('ThreadReplyService.readReply')(function* (
			pending: PendingThread
		) {
			const { identities } = yield* OwnedIdentities
			const comments = yield* api.listThreadComments(pending.thread.id)
			const last = comments.at(-1)
			if (last?.databaseId !== pending.ref.commentId)
				return Option.none<PendingReply>()
			return Option.some({
				threadId: pending.thread.id,
				fingerprint: pending.thread.marker.fingerprint,
				commentId: pending.ref.commentId,
				digest: toBodyDigest(last.body),
				author: pending.ref.author,
				body: last.body.slice(0, MAX_REPLY_CHARS),
				disputes: countDisputes(comments, identities),
			} satisfies PendingReply)
		})

		const collect = Effect.fn('ThreadReplyService.collect')(function* (
			input: ReplyCollectInput
		) {
			const pending = input.threads.flatMap((thread): PendingThread[] => {
				const ref = getPendingReply(thread)
				return ref ? [{ thread, ref }] : []
			})
			const writers = yield* getWriters(pending.map(entry => entry.ref.author))
			const counting = pending.filter(entry =>
				writers.has(entry.ref.author.toLowerCase())
			)
			const batch = getRotated(
				counting,
				input.rotation,
				MAX_REPLY_THREADS
			).slice(0, MAX_REPLY_THREADS)
			const replies = yield* Effect.forEach(
				batch,
				entry => readReply(entry).pipe(Effect.orElseSucceed(Option.none)),
				{ concurrency: 1 }
			)
			return replies.flatMap(Option.toArray)
		})

		const answer = Effect.fn('ThreadReplyService.answer')(function* (
			applied: AppliedReply,
			links: BlobLinks
		) {
			const { thread, decision } = applied
			const body = formatReplyAnswer(decision, links, applied.commentId)
			return yield* api.replyToThread(thread.id, body).pipe(
				Effect.tap(() =>
					CLOSING_ACTIONS.has(decision.action)
						? api.resolveThread(thread.id).pipe(Effect.ignore)
						: Effect.void
				),
				Effect.as([applied]),
				Effect.orElseSucceed((): AppliedReply[] => [])
			)
		})

		const apply = Effect.fn('ThreadReplyService.apply')(function* (
			input: ReplyApplyInput
		) {
			const applicable = getApplicableReplies(input.decisions, input.threads)
			const writers = yield* getWriters(
				applicable.flatMap(entry => entry.thread.latestAuthor?.login ?? [])
			)
			// A review job could name a reader's reply, or the author lost access since prepare.
			const allowed = applicable.filter(entry =>
				writers.has(entry.thread.latestAuthor?.login.toLowerCase() ?? '')
			)
			const answered = yield* Effect.forEach(
				allowed,
				entry => answer(entry, input.links),
				{ concurrency: 1 }
			)
			return answered.flat()
		})

		return { collect, apply }
	})
)
