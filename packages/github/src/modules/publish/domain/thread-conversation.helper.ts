import {
	type Change,
	commitShaSchema,
	getIntentionalLimit,
	normalizeRepoPath,
	type ReplyItem,
	type ReviewConfig,
} from '@mng-review/domain'
import type { DecidedReply } from '@mng-review/engine'
import { Schema } from 'effect'
import type { BotIdentity } from '../../../platform/bot-identity.helper'
import type {
	CollaboratorRole,
	ReviewThread,
	ThreadComment,
} from '../../../platform/github-api.schema'
import { isOwnerAccess } from '../../command/domain/command-access.helper'
import { isBotComment } from './bot-thread.helper'
import { parseReplyMarker } from './publish-marker.parser'
import type { ThreadKind } from './publish-marker.schema'
import type { AnswerCounts, AppliedReply, BotThread } from './publish.types'
import { toThreadFinding } from './thread-recheck.helper'
import type { DecidedThreadReply, PendingReply } from './thread-reply.schema'

const isCommitSha = Schema.is(commitShaSchema)
/** Thread kinds whose replies the bot answers; a nit thread is never a conversation. */
const ANSWERED_KINDS = [
	'bug',
	'unverified',
] as const satisfies readonly ThreadKind[]

/** The author's comment a thread waits on: its `databaseId` and login. */
export interface ReplyRef {
	readonly commentId: number
	readonly author: string
}

/** A pending reply with what the engine decides it on. */
export interface ThreadReplyItem {
	readonly reply: PendingReply
	readonly item: ReplyItem
}

/**
 * True when the converse answers replies in the thread: a bug or unverified thread that does not
 * wait for the owner, open, or resolved but holding the reply a dispatched converse was sent for,
 * which it then treats as open under the normal reply rules.
 */
export function isAnswerableThread(
	thread: BotThread,
	waiting: readonly string[],
	held?: boolean
): boolean {
	const kinds: readonly ThreadKind[] = ANSWERED_KINDS
	return (
		(!thread.resolved || held === true) &&
		kinds.includes(thread.marker.kind) &&
		!waiting.includes(thread.id) &&
		!thread.sentToOwner
	)
}

/**
 * The reply a thread waits on, or `undefined`: the thread is open (not closed by the bot either),
 * a bug or unverified thread, not waiting for the owner (in `waiting` or `sentToOwner`), and its
 * latest comment is a person's (`User`) that does not end with a marker of the bot's form.
 */
export function getPendingReply(
	thread: BotThread,
	waiting: readonly string[]
): ReplyRef | undefined {
	const kinds: readonly ThreadKind[] = ANSWERED_KINDS
	const { latestAuthor, latestCommentId } = thread
	if (
		thread.resolved ||
		thread.replies === 0 ||
		thread.latestMarked ||
		!kinds.includes(thread.marker.kind) ||
		waiting.includes(thread.id) ||
		thread.sentToOwner ||
		latestAuthor?.type !== 'User' ||
		latestCommentId === undefined
	)
		return undefined
	return { commentId: latestCommentId, author: latestAuthor.login }
}

/**
 * The bot's earlier `disputed` answers in a thread: comments of an owned bot, unedited by anyone
 * else, whose reply marker says `disputed`. A person pasting such a marker counts for nothing.
 */
export function countDisputes(
	comments: readonly ThreadComment[],
	owned: readonly BotIdentity[]
): number {
	return comments.filter(
		comment =>
			isBotComment(comment, owned) &&
			parseReplyMarker(comment.body)?.action === 'disputed'
	).length
}

/**
 * True when an owner cleared a waiting thread: `resolver`, who resolved it on GitHub, is an admin
 * or a login in `commands.allow` that still has write access. `roles` holds the resolvers' access
 * by lower-case login; one missing from it, as after a failed lookup, clears nothing.
 */
export function getOwnerCleared(
	resolver: string | undefined,
	roles: ReadonlyMap<string, CollaboratorRole>,
	allow: readonly string[]
): boolean {
	if (resolver === undefined) return false
	const access = roles.get(resolver.toLowerCase())
	return access !== undefined && isOwnerAccess(resolver, access, allow)
}

/**
 * Who resolved each resolved thread, by node id, from the raw read: a waiting thread whose first
 * comment someone edited is no longer the bot's, and an owner can still clear it.
 */
export function toResolvers(
	threads: readonly Pick<ReviewThread, 'id' | 'isResolved' | 'resolvedBy'>[]
): ReadonlyMap<string, string> {
	return new Map(
		threads.flatMap(thread =>
			thread.isResolved && thread.resolvedBy
				? [[thread.id, thread.resolvedBy.login] as const]
				: []
		)
	)
}

/**
 * A thread read made after the answers, and whether it read (`false` means the first read stands
 * in).
 */
export interface FreshRead {
	readonly raw: readonly Pick<
		ReviewThread,
		'id' | 'isResolved' | 'resolvedBy'
	>[]
	readonly reread: boolean
}

/**
 * Who resolved each thread after this run's answers, for `getCleared`: none when the read after
 * the answers failed, since the first read's resolutions predate them, and none for a thread an
 * answer could not reopen after it was posted (`unsettled`).
 */
export function toFreshResolvers(
	read: FreshRead,
	answered: readonly AppliedReply[]
): ReadonlyMap<string, string> {
	if (!read.reread) return new Map()
	const unsettled = new Set(
		answered.flatMap(entry => (entry.unsettled ? [entry.thread.id] : []))
	)
	return new Map(
		[...toResolvers(read.raw)].filter(([id]) => !unsettled.has(id))
	)
}

/** The threads an answer of this run or an earlier one left unsettled (`ThreadSettleService`). */
export function toUnsettledIds(
	answered: readonly AppliedReply[],
	left: readonly string[]
): ReadonlySet<string> {
	return new Set([
		...answered.flatMap(entry => (entry.unsettled ? [entry.thread.id] : [])),
		...left,
	])
}

/**
 * The pending replies the engine can decide on, each with its item: the thread is among `threads`
 * with the reply's fingerprint, its commit is a full SHA and its path a repository-relative one, as
 * the engine passes both to git unchecked. Any other reply is left out.
 */
export function toReplyItems(
	replies: readonly PendingReply[],
	threads: readonly BotThread[]
): ThreadReplyItem[] {
	return replies.flatMap(reply => {
		const thread = threads.find(entry => entry.id === reply.threadId)
		if (
			!thread ||
			thread.marker.fingerprint !== reply.fingerprint ||
			!isCommitSha(thread.commit) ||
			normalizeRepoPath(thread.path) !== thread.path
		)
			return []
		const item = {
			finding: toThreadFinding(thread),
			base: thread.commit,
			reply: reply.body,
			disputes: reply.disputes,
		} satisfies ReplyItem
		return [{ reply, item }]
	})
}

/**
 * The decisions that still hold in a fresh read, each with its thread: the thread's pending reply
 * (`getPendingReply`) is the comment the decision names, with the digest it was decided on, or the
 * decision names an older reply in a thread the converse answers while answers name replies
 * (`naming`), which the answer's own read of the whole thread checks; and the fingerprint matches.
 * Anything else is dropped, since someone answered or edited meanwhile; a thread decided twice
 * counts once.
 */
export function getApplicableReplies(
	decisions: readonly DecidedThreadReply[],
	threads: readonly BotThread[],
	waiting: readonly string[],
	held?: number,
	naming?: boolean
): AppliedReply[] {
	const byId = new Map(threads.map(thread => [thread.id, thread]))
	return decisions.flatMap((decided, index) => {
		const thread = byId.get(decided.threadId)
		if (
			!thread ||
			decisions.findIndex(other => other.threadId === decided.threadId) !==
				index ||
			thread.marker.fingerprint !== decided.fingerprint ||
			!isStillPending(thread, decided, waiting, naming === true ? held : null)
		)
			return []
		return [
			{
				thread,
				decision: decided.decision,
				commentId: decided.commentId,
				digest: decided.digest,
				...(decided.named ? { named: decided.named } : {}),
			},
		]
	})
}

/**
 * True when the decided reply is the thread's pending latest reply at the decided digest, or an
 * older reply in a thread the converse answers (the answer reads the whole thread before posting).
 * With a dispatched reply (`held`), a resolved thread is answered as if open whichever of its
 * replies was decided; that the thread holds `held` is checked by the answer's read of the whole
 * thread (`ReplyNamingService.readNamed`), as the collection checked it.
 */
function isStillPending(
	thread: BotThread,
	decided: DecidedThreadReply,
	waiting: readonly string[],
	held: number | undefined | null
): boolean {
	const asOpen = held !== null && held !== undefined
	// Without naming (`null`), only the latest reply is ever decided, as before the rating.
	if (thread.latestCommentId !== decided.commentId)
		return held !== null && isAnswerableThread(thread, waiting, asOpen)
	if (thread.latestDigest !== decided.digest) return false
	if (held === decided.commentId || (asOpen && thread.resolved))
		return isAnswerableThread(thread, waiting, true)
	return getPendingReply(thread, waiting)?.commentId === decided.commentId
}

/**
 * Whether the thread's finding is past the limit an `intentional` reply cannot pass
 * (`getIntentionalLimit`): the severity from the bot's marker, the path from the thread, the rules
 * in force and the change publishing read from git. Without a change it counts as past the limit.
 */
export function isPastLimit(
	thread: BotThread,
	config: ReviewConfig,
	change: Pick<Change, 'files'> | undefined
): boolean {
	if (change === undefined) return true
	return getIntentionalLimit(toThreadFinding(thread), config, change) !== 'ok'
}

/** The answers by action. */
export function toAnswerCounts(
	answered: readonly AppliedReply[]
): AnswerCounts {
	const actions = answered.map(entry => entry.decision.action)
	return Object.fromEntries(
		[...new Set(actions)].map(action => [
			action,
			actions.filter(entry => entry === action).length,
		])
	)
}

/**
 * The engine's decisions bound to their threads, in the order of `pairs`, which `results` follows.
 * A reply left `seen` by a failure of the model, git or the budget is left out, so the next run
 * tries it again.
 */
export function toDecidedReplies(
	pairs: readonly ThreadReplyItem[],
	results: readonly DecidedReply[]
): DecidedThreadReply[] {
	return results.flatMap((result, index) => {
		const pair = pairs[index]
		if (!pair || result.error !== undefined) return []
		const { threadId, fingerprint, commentId, digest, named } = pair.reply
		return [
			{
				threadId,
				fingerprint,
				commentId,
				digest,
				decision: result.decision,
				...(named ? { named } : {}),
			},
		]
	})
}
