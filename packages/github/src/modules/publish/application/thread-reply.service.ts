import type { Change, ReviewConfig } from '@mng-review/domain'
import { Context, Effect, Layer, Option } from 'effect'
import type {
	CollaboratorRole,
	ReviewThread,
	ThreadComment,
} from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { hasWriteAccess } from '../../command/domain/command-access.helper'
import {
	getOwnerAnswered,
	getUnreadOwnerThreads,
	hasOwnerAnswer,
	toBodyDigest,
} from '../domain/bot-thread.helper'
import {
	MAX_REPLY_CHARS,
	MAX_REPLY_THREADS,
	NEEDS_OWNER_LABEL,
} from '../domain/publish.constants'
import type {
	AppliedReply,
	BotThread,
	LabelOutcome,
} from '../domain/publish.types'
import {
	countDisputes,
	getApplicableReplies,
	getOwnerCleared,
	getPendingReply,
	isPastLimit,
	type ReplyRef,
} from '../domain/thread-conversation.helper'
import { getRotated } from '../domain/thread-recheck.helper'
import type {
	DecidedThreadReply,
	PendingReply,
} from '../domain/thread-reply.schema'
import type { BlobLinks } from '../presentation/thread-comment.formatter'
import { formatReplyAnswer } from '../presentation/thread-reply.formatter'

const NOT_FOUND_STATUS = 404
/** Answers after which the bot also asks GitHub to resolve the thread. */
const CLOSING_ACTIONS: ReadonlySet<string> = new Set(['resolved', 'accepted'])

/** What the prepare step collects replies from. */
export interface ReplyCollectInput {
	readonly pullNumber: number
	/** The bot's threads, read before. */
	readonly threads: readonly BotThread[]
	/** Shifts the batch when more than `MAX_REPLY_THREADS` replies wait: the run count. */
	readonly rotation: number
	/** Thread ids the summary marker says wait for the owner. */
	readonly waiting: readonly string[]
}

/** The review's decisions and the publisher's fresh read of the bot's threads. */
export interface ReplyApplyInput {
	readonly links: BlobLinks
	readonly decisions: readonly DecidedThreadReply[]
	readonly threads: readonly BotThread[]
	readonly waiting: readonly string[]
	/** The rules in force: `disputes` and `risk_paths` set the limit (`isPastLimit`). */
	readonly config: ReviewConfig
	/** The reviewed change as publishing read it from git; `undefined` when the read failed. */
	readonly change: Pick<Change, 'files'> | undefined
}

/** The waiting threads and who resolved each resolved thread of a fresh read (`toResolvers`). */
export interface ClearedInput {
	readonly waiting: readonly string[]
	readonly resolvers: ReadonlyMap<string, string>
	/** `commands.allow` of the rules in force. */
	readonly allow: readonly string[]
}

/** A pending reply found in a thread, before its comments are read. */
interface PendingThread {
	readonly thread: BotThread
	readonly ref: ReplyRef
}

/**
 * The author's side of the bot's threads. `collect` finds the replies worth a decision before any
 * model call; `apply` writes the review's decisions after publishing's own read; `getCleared` and
 * `syncLabel` keep the `needs-owner` state. A GitHub error never fails a call: a reply that cannot
 * be checked does not count, a failed write leaves its thread as it was.
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
		 * still has write access, reading each thread again right before its answer and skipping it
		 * when the reply is no longer the latest comment or was edited, and tries to resolve a thread
		 * it closes; a skipped or failed answer leaves the thread out of the result. An `accepted`
		 * decision on a finding past the limit (`isPastLimit`) is dropped; a `needs-owner` decision
		 * stands only past the limit or the rounds.
		 */
		readonly apply: (
			input: ReplyApplyInput
		) => Effect.Effect<readonly AppliedReply[], never, OwnedIdentities>
		/**
		 * Ids of the raw threads, open or resolved, with an owned, unedited `needs-owner` answer,
		 * whoever owns the first comment now: from the latest comments the read brought, and for a
		 * longer thread the bot started (`getUnreadOwnerThreads`), from all its comments. A failed
		 * read fails the call.
		 */
		readonly getSentToOwner: (
			threads: readonly ReviewThread[]
		) => Effect.Effect<readonly string[], GitHubApiError, OwnedIdentities>
		/** Ids of waiting threads an admin or an allowed login resolved on GitHub. */
		readonly getCleared: (
			input: ClearedInput
		) => Effect.Effect<ReadonlySet<string>>
		/** Adds the label while threads wait, removes it when the last one was cleared. */
		readonly syncLabel: (
			pullNumber: number,
			before: number,
			after: number
		) => Effect.Effect<LabelOutcome>
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
				const ref = getPendingReply(thread, input.waiting)
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

		/**
		 * True when the thread's latest comment is still the decided reply with the digest it was
		 * decided on; a failed read is false. The reply mutation has no precondition, so this read
		 * right before it narrows the window for an edit or a newer comment but cannot close it.
		 */
		const isStillLatest = Effect.fn('ThreadReplyService.isStillLatest')(
			function* (applied: AppliedReply) {
				const comments = yield* api
					.listThreadComments(applied.thread.id)
					.pipe(Effect.orElseSucceed((): readonly ThreadComment[] => []))
				const last = comments.at(-1)
				return (
					last !== undefined &&
					last.databaseId === applied.commentId &&
					toBodyDigest(last.body) === applied.thread.latestDigest
				)
			}
		)

		const answer = Effect.fn('ThreadReplyService.answer')(function* (
			applied: AppliedReply,
			links: BlobLinks
		) {
			const { thread, decision } = applied
			// Someone edited the reply or answered it since the first read: a later run decides again.
			if (!(yield* isStillLatest(applied))) return []
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

		/**
		 * Whether a decision may stand as publishing reads the thread: any but `needs-owner` may; that
		 * one only for a finding past the limit an `intentional` reply cannot pass (with the change git
		 * read), or a thread whose owned, unedited `disputed` answers reach `disputes.max_rounds`. A
		 * failed read keeps it out.
		 */
		const mayStand = Effect.fn('ThreadReplyService.mayStand')(function* (
			applied: AppliedReply,
			input: ReplyApplyInput
		) {
			if (applied.decision.action !== 'needs-owner') return true
			// Without the change the limit is unknown, so only the rounds can send it to the owner.
			if (
				input.change !== undefined &&
				isPastLimit(applied.thread, input.config, input.change)
			)
				return true
			const { identities } = yield* OwnedIdentities
			return yield* api.listThreadComments(applied.thread.id).pipe(
				Effect.map(
					comments =>
						countDisputes(comments, identities) >=
						input.config.disputes.max_rounds
				),
				Effect.orElseSucceed(() => false)
			)
		})

		const apply = Effect.fn('ThreadReplyService.apply')(function* (
			input: ReplyApplyInput
		) {
			// The outcome file is the review job's: it may accept what only the owner can.
			const applicable = getApplicableReplies(
				input.decisions,
				input.threads,
				input.waiting
			).filter(
				entry =>
					entry.decision.action !== 'accepted' ||
					!isPastLimit(entry.thread, input.config, input.change)
			)
			const writers = yield* getWriters(
				applicable.flatMap(entry => entry.thread.latestAuthor?.login ?? [])
			)
			// A review job could name a reader's reply, or the author lost access since prepare.
			const allowed = applicable.filter(entry =>
				writers.has(entry.thread.latestAuthor?.login.toLowerCase() ?? '')
			)
			const standing = yield* Effect.filter(
				allowed,
				entry => mayStand(entry, input),
				{ concurrency: 1 }
			)
			const answered = yield* Effect.forEach(
				standing,
				entry => answer(entry, input.links),
				{ concurrency: 1 }
			)
			return answered.flat()
		})

		const getSentToOwner = Effect.fn('ThreadReplyService.getSentToOwner')(
			function* (threads: readonly ReviewThread[]) {
				const { identities } = yield* OwnedIdentities
				const found = yield* Effect.filter(
					getUnreadOwnerThreads(threads, identities),
					thread =>
						api
							.listThreadComments(thread.id)
							.pipe(
								Effect.map(comments => hasOwnerAnswer(comments, identities))
							),
					{ concurrency: 1 }
				)
				return [
					...getOwnerAnswered(threads, identities),
					...found.map(thread => thread.id),
				]
			}
		)

		const getCleared = Effect.fn('ThreadReplyService.getCleared')(function* (
			input: ClearedInput
		) {
			const resolved = input.waiting.flatMap(id => {
				const resolver = input.resolvers.get(id)
				return resolver === undefined ? [] : [{ id, resolver }]
			})
			const logins = [
				...new Set(resolved.map(entry => entry.resolver.toLowerCase())),
			]
			const entries = yield* Effect.forEach(
				logins,
				login =>
					readRole(login).pipe(
						Effect.map(access => (access ? [[login, access] as const] : []))
					),
				{ concurrency: 1 }
			)
			const roles = new Map(entries.flat())
			return new Set(
				resolved
					.filter(entry => getOwnerCleared(entry.resolver, roles, input.allow))
					.map(entry => entry.id)
			)
		})

		const syncLabel = Effect.fn('ThreadReplyService.syncLabel')(function* (
			pullNumber: number,
			before: number,
			after: number
		) {
			if (after > 0)
				return yield* api.addLabel(pullNumber, NEEDS_OWNER_LABEL).pipe(
					Effect.as<LabelOutcome>('added'),
					Effect.orElseSucceed((): LabelOutcome => 'failed')
				)
			if (before === 0) return 'none' satisfies LabelOutcome
			return yield* api.removeLabel(pullNumber, NEEDS_OWNER_LABEL).pipe(
				Effect.as<LabelOutcome>('removed'),
				Effect.catchIf(
					error => error.status === NOT_FOUND_STATUS,
					() => Effect.succeed<LabelOutcome>('removed')
				),
				Effect.orElseSucceed((): LabelOutcome => 'failed')
			)
		})

		return { collect, apply, getSentToOwner, getCleared, syncLabel }
	})
)
