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
import type { ThreadComment } from '../../../platform/github-api.schema'
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
 * The reply a thread waits on, or `undefined`: the thread is open (not closed by the bot either),
 * a bug or unverified thread, and its latest comment is a person's (`User`) that does not end with
 * a marker of the bot's form.
 */
export function getPendingReply(thread: BotThread): ReplyRef | undefined {
	const kinds: readonly ThreadKind[] = ANSWERED_KINDS
	const { latestAuthor, latestCommentId } = thread
	if (
		thread.resolved ||
		thread.replies === 0 ||
		thread.latestMarked ||
		!kinds.includes(thread.marker.kind) ||
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
 * (`getPendingReply`) is the comment the decision names, with the digest it was decided on, and the
 * fingerprint matches. Anything else is dropped, since someone answered or edited meanwhile; a
 * thread decided twice counts once.
 */
export function getApplicableReplies(
	decisions: readonly DecidedThreadReply[],
	threads: readonly BotThread[]
): AppliedReply[] {
	const byId = new Map(threads.map(thread => [thread.id, thread]))
	return decisions.flatMap((decided, index) => {
		const thread = byId.get(decided.threadId)
		if (
			!thread ||
			decisions.findIndex(other => other.threadId === decided.threadId) !==
				index ||
			thread.marker.fingerprint !== decided.fingerprint ||
			getPendingReply(thread)?.commentId !== decided.commentId ||
			thread.latestDigest !== decided.digest
		)
			return []
		return [
			{ thread, decision: decided.decision, commentId: decided.commentId },
		]
	})
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
		const { threadId, fingerprint, commentId, digest } = pair.reply
		return [
			{ threadId, fingerprint, commentId, digest, decision: result.decision },
		]
	})
}
