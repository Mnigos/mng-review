import type { Change, ReviewConfig } from '@mng-review/domain'
import { Context, Effect, Layer, Option } from 'effect'
import type { ReviewThread } from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
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
	CLOSING_ACTIONS,
} from '../domain/publish.constants'
import type {
	AppliedReply,
	BotThread,
	LabelOutcome,
} from '../domain/publish.types'
import {
	countDisputes,
	getApplicableReplies,
	getPendingReply,
	isPastLimit,
	toUnsettledIds,
	type ReplyRef,
} from '../domain/thread-conversation.helper'
import { getRotated } from '../domain/thread-recheck.helper'
import type {
	DecidedThreadReply,
	PendingReply,
} from '../domain/thread-reply.schema'
import type { BlobLinks } from '../presentation/thread-comment.formatter'
import { formatReplyAnswer } from '../presentation/thread-reply.formatter'
import {
	ReplyNamingService,
	ReplyNamingServiceLive,
} from './reply-naming.service'
import {
	type ClearedInput,
	ThreadSettleService,
	ThreadSettleServiceLive,
} from './thread-settle.service'

const NOT_FOUND_STATUS = 404

/** What the prepare step collects replies from. */
export interface ReplyCollectInput {
	readonly pullNumber: number
	/** The bot's threads, read before. */
	readonly threads: readonly BotThread[]
	/** Shifts the batch when more than `MAX_REPLY_THREADS` replies wait: the run count. */
	readonly rotation: number
	/** Thread ids the summary marker says wait for the owner. */
	readonly waiting: readonly string[]
	/** A dispatched converse's reply: a resolved thread holding it is answered as if open. */
	readonly held?: number
	/**
	 * With a rating: also pick threads whose older reply by a writer no app answer names at its
	 * current version, so every reply that can hold the pull request gets an answer.
	 */
	readonly naming?: boolean
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
	/** The run id the answers' markers name; without it an answer names no replies. */
	readonly run?: number
	/** A dispatched converse's reply, answered in a resolved thread too. */
	readonly held?: number
}

/** A pending reply found in a thread, before its comments are read. */
export interface PendingThread {
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
		/** Ids of waiting threads an owner's resolution cleared (`ThreadSettleService.getCleared`). */
		readonly getCleared: (
			input: ClearedInput
		) => Effect.Effect<ReadonlySet<string>, never, OwnedIdentities>
		/** The threads with every resolved bug's unsettled state known (`resolveUnsettled`). */
		readonly resolveUnsettled: ThreadSettleService['Service']['resolveUnsettled']
		/**
		 * Settles the threads' unsettled app answers (`ThreadSettleService.settle`), except in the
		 * threads this run answered, whose own answer decided them and which the read predates; the
		 * ids still unsettled after it, with those this run's `answered` left so.
		 */
		readonly settle: (
			threads: readonly ReviewThread[],
			answered: readonly AppliedReply[]
		) => Effect.Effect<ReadonlySet<string>, never, OwnedIdentities>
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
		const naming = yield* ReplyNamingService
		const settling = yield* ThreadSettleService
		const { reopen } = settling
		const {
			getWriters,
			readNamed,
			hasLaterReply,
			getNamedVersions,
			findOlderReplies,
		} = naming

		/**
		 * The reply as the thread's comments show it now. Without naming, none once another comment
		 * followed it, as before the rating. With naming, none while a later writer's reply waits for
		 * an answer at its current version (`hasLaterReply`, the check `readNamed` makes), so an older
		 * reply edited after a later one was answered is still collected.
		 */
		const readReply = Effect.fn('ThreadReplyService.readReply')(function* (
			pending: PendingThread,
			named: boolean
		) {
			const { identities } = yield* OwnedIdentities
			const comments = yield* api.listThreadComments(pending.thread.id)
			const index = comments.findLastIndex(
				comment => comment.databaseId === pending.ref.commentId
			)
			const reply = comments[index]
			if (!reply) return Option.none<PendingReply>()
			const later = named
				? yield* hasLaterReply(comments, index)
				: index !== comments.length - 1
			if (later) return Option.none<PendingReply>()
			return Option.some({
				threadId: pending.thread.id,
				fingerprint: pending.thread.marker.fingerprint,
				commentId: pending.ref.commentId,
				digest: toBodyDigest(reply.body),
				author: pending.ref.author,
				body: reply.body.slice(0, MAX_REPLY_CHARS),
				disputes: countDisputes(comments, identities),
				...(named ? { named: yield* getNamedVersions(comments) } : {}),
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
			const older =
				input.naming === true && counting.length < MAX_REPLY_THREADS
					? yield* findOlderReplies(input, counting)
					: []
			const batch = getRotated(
				[...counting, ...older],
				input.rotation,
				MAX_REPLY_THREADS
			).slice(0, MAX_REPLY_THREADS)
			const replies = yield* Effect.forEach(
				batch,
				entry =>
					readReply(entry, input.naming === true).pipe(
						Effect.orElseSucceed(Option.none)
					),
				{ concurrency: 1 }
			)
			return replies.flatMap(Option.toArray)
		})

		/**
		 * Answers one decision after the answer's own read of the thread. A resolved thread that a
		 * non-closing answer keeps open is reopened first, so the next thread read counts it; when it
		 * cannot be reopened, nothing is posted. GitHub gives no resolution time, so such a thread and
		 * every thread sent to the owner is reopened again after the answer, which is posted
		 * `unsettled` and settled by an edit once that reopen lands (`ThreadSettleService`): only a
		 * resolution after it then stands (`getCleared`). An answer left unsettled stays so marked.
		 */
		const answer = Effect.fn('ThreadReplyService.answer')(function* (
			applied: AppliedReply,
			links: BlobLinks,
			input: Pick<ReplyApplyInput, 'run' | 'held'>
		) {
			const { thread, decision } = applied
			// Someone edited the reply or answered it since the first read: a later run decides again.
			const named = yield* readNamed(applied, input.run, input.held)
			if (!named) return []
			const closing = CLOSING_ACTIONS.has(decision.action)
			const reopens = thread.resolved && !closing
			if (reopens && !(yield* reopen(thread.id))) return []
			const settles = reopens || decision.action === 'needs-owner'
			const body = formatReplyAnswer(
				decision,
				links,
				applied.commentId,
				named.entry,
				settles
			)
			const posted = yield* api.replyToThread(thread.id, body).pipe(
				Effect.map(databaseId => ({ databaseId: databaseId ?? null, body })),
				Effect.orElseSucceed(() => undefined)
			)
			if (!posted) return []
			if (closing) yield* api.resolveThread(thread.id).pipe(Effect.ignore)
			if (!settles) return [applied]
			const settled = yield* settling.settleAnswer(thread.id, posted)
			return [settled ? applied : { ...applied, unsettled: true as const }]
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
				input.waiting,
				input.held,
				input.run !== undefined
			).filter(
				entry =>
					entry.decision.action !== 'accepted' ||
					!isPastLimit(entry.thread, input.config, input.change)
			)
			const writers = yield* getWriters(
				applicable.flatMap(entry => entry.thread.latestAuthor?.login ?? [])
			)
			// A review job could name a reader's reply, or the author lost access since prepare. An
			// older reply's author is checked against the answer's own read of the thread.
			const allowed = applicable.filter(
				entry =>
					entry.thread.latestCommentId !== entry.commentId ||
					writers.has(entry.thread.latestAuthor?.login.toLowerCase() ?? '')
			)
			const standing = yield* Effect.filter(
				allowed,
				entry => mayStand(entry, input),
				{ concurrency: 1 }
			)
			const answered = yield* Effect.forEach(
				standing,
				entry => answer(entry, input.links, input),
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

		const settle = Effect.fn('ThreadReplyService.settle')(function* (
			threads: readonly ReviewThread[],
			answered: readonly AppliedReply[]
		) {
			const ids = new Set(answered.map(entry => entry.thread.id))
			const left = yield* settling.settle(
				threads.filter(thread => !ids.has(thread.id))
			)
			return toUnsettledIds(answered, left)
		})

		return {
			collect,
			apply,
			getSentToOwner,
			getCleared: settling.getCleared,
			resolveUnsettled: settling.resolveUnsettled,
			settle,
			syncLabel,
		}
	})
).pipe(
	Layer.provide(Layer.mergeAll(ReplyNamingServiceLive, ThreadSettleServiceLive))
)
