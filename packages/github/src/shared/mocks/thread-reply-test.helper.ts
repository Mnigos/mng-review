import type { ReplyApplyInput } from '../../modules/publish/application/thread-reply.service'
import { toBodyDigest } from '../../modules/publish/domain/bot-thread.helper'
import { MARKER_VERSION } from '../../modules/publish/domain/publish.constants'
import type { BotThread } from '../../modules/publish/domain/publish.types'
import type {
	DecidedThreadReply,
	PendingReply,
	ThreadReplyDecision,
} from '../../modules/publish/domain/thread-reply.schema'
import { toMarkerComment } from '../../modules/publish/presentation/thread-comment.formatter'
import { RECENT_COMMENTS } from '../../platform/github-api.constants'
import type {
	ReviewThread,
	ThreadComment,
} from '../../platform/github-api.schema'
import { config } from './domain-test.helper'
import {
	botThread,
	reviewThread,
	threadReply,
	LINKS,
} from './publish-test.helper'

/** The shared reply's text, as the thread read and the prepared reply carry it. */
const REPLY_BODY = 'fixed after the guard'

/** An owned finding followed by a person's latest reply. */
export function pendingReviewThread(
	overrides: Partial<ReviewThread> = {}
): ReviewThread {
	const thread = reviewThread()
	return {
		...thread,
		comments: { ...thread.comments, totalCount: 2 },
		latest: {
			nodes: [
				{
					databaseId: 42,
					body: REPLY_BODY,
					author: { __typename: 'User', login: 'contributor' },
					editor: null,
					originalCommit: null,
				},
			],
		},
		...overrides,
	}
}

/** The publish domain's view of a pending author reply. */
export function pendingBotThread(
	overrides: Partial<BotThread> = {}
): BotThread {
	return botThread({
		replies: 1,
		latestAuthor: { type: 'User', login: 'contributor' },
		latestCommentId: 42,
		latestMarked: false,
		latestDigest: toBodyDigest(REPLY_BODY),
		...overrides,
	})
}

/** A prepared reply, bound to the shared finding and comment. */
export function pendingReply(
	overrides: Partial<PendingReply> = {}
): PendingReply {
	return {
		threadId: 'thread',
		fingerprint: botThread().marker.fingerprint,
		commentId: 42,
		digest: toBodyDigest(REPLY_BODY),
		author: 'contributor',
		body: REPLY_BODY,
		disputes: 0,
		...overrides,
	}
}

/** An intentional reply whose evidence and memory passed the review job's checks. */
export const ACCEPTED_DECISION = {
	action: 'accepted',
	reason: 'The caller guards it.',
	memory: 'Keep the guard.',
	evidence: ['src/store.ts:10'],
} as const satisfies ThreadReplyDecision

const SEEN = { action: 'seen' } as const satisfies ThreadReplyDecision

/** A decision bound to the shared pending reply. */
export function decidedReply(
	decision: ThreadReplyDecision = SEEN,
	overrides: Partial<DecidedThreadReply> = {}
): DecidedThreadReply {
	const { threadId, fingerprint, commentId, digest } = pendingReply()
	return { threadId, fingerprint, commentId, digest, decision, ...overrides }
}

/** The default rules and an empty change, for `apply`'s limit and owner checks. */
export function replyRules(): Pick<ReplyApplyInput, 'config' | 'change'> {
	return { config: config(), change: { files: [] } }
}

/** An owned answer used to exercise ownership and round counting. */
export function markedThreadReply(
	action: 'needs-owner' | 'disputed' = 'needs-owner',
	overrides: Partial<ThreadComment> = {}
): ThreadComment {
	return threadReply({
		body: toMarkerComment('reply', {
			v: MARKER_VERSION,
			action,
			commit: LINKS.head,
			reply: 42,
		}),
		...overrides,
	})
}

/** An owner answer followed by human comments, with GitHub's bounded latest connection. */
export function ownerReviewThread(
	following = 1,
	overrides: Partial<ReviewThread> = {}
): ReviewThread {
	const root = reviewThread()
	const comments = [
		markedThreadReply(),
		...Array.from({ length: following }, (_, index) =>
			threadReply({
				databaseId: 100 + index,
				body: 'More context',
				author: { __typename: 'User', login: 'contributor' },
			})
		),
	]
	return {
		...root,
		comments: { ...root.comments, totalCount: 1 + comments.length },
		latest: { nodes: comments.slice(-RECENT_COMMENTS) },
		...overrides,
	}
}

/** The shared finding's thread under another id, with `totalCount` comments and none of them read. */
export function rawThread(id: string, totalCount: number): ReviewThread {
	const root = reviewThread()
	return { ...root, id, comments: { ...root.comments, totalCount } }
}

/** A waiting thread whose bot-authored root a writer edited, without editing the answer. */
export function editedOwnerReviewThread(
	following = 1,
	overrides: Partial<ReviewThread> = {}
): ReviewThread {
	const thread = ownerReviewThread(following)
	return {
		...thread,
		comments: {
			...thread.comments,
			nodes: thread.comments.nodes.map(comment => ({
				...comment,
				editor: { __typename: 'User', login: 'contributor' },
			})),
		},
		...overrides,
	}
}

/** Where a thread holds the token app's newest answer: in its latest window or further back. */
export type AnswerPlace = 'window' | 'outside'

/** A resolved bug thread, and all its comments, whose newest token answer is unsettled. */
export interface UnsettledBugThread {
	readonly thread: ReviewThread
	/** The whole thread as the per-thread read gives it. */
	readonly comments: readonly ThreadComment[]
}

/**
 * A resolved bug thread whose newest answer of the token's app (`still-found`, posted unsettled
 * after its reopen failed) sits in its latest window, or, `outside`, only in the whole thread
 * behind more people's comments than the window holds.
 */
export function unsettledBugThread(place: AnswerPlace): UnsettledBugThread {
	const thread = reviewThread()
	const answer = threadReply({
		databaseId: 7,
		body: toMarkerComment('reply', {
			v: MARKER_VERSION,
			action: 'still-found',
			commit: LINKS.head,
			reply: 6,
			unsettled: true,
		}),
	})
	const later = Array.from({ length: RECENT_COMMENTS }, (_, index) =>
		threadReply({
			databaseId: 100 + index,
			author: { __typename: 'User', login: 'contributor' },
			body: 'later',
		})
	)
	const latest = place === 'window' ? [answer] : later
	const comments = [
		...thread.comments.nodes,
		...(place === 'window' ? [] : [answer]),
		...latest,
	]
	return {
		thread: {
			...thread,
			isResolved: true,
			resolvedBy: { login: 'contributor' },
			comments: { ...thread.comments, totalCount: comments.length },
			latest: { nodes: latest },
		},
		comments,
	}
}

/** Two resolved bot threads longer than the latest comments a thread read brings. */
export interface LongOwnerThreads {
	/** Holds no `needs-owner` answer when read whole. */
	readonly unanswered: ReviewThread
	/** Holds a `needs-owner` answer before its latest comments. */
	readonly answered: ReviewThread
	/** Every comment of `answered`, as a whole-thread read returns them. */
	readonly answeredComments: readonly ThreadComment[]
}

/** A thread that never waited and one that does, both read whole only by `listThreadComments`. */
export function longOwnerThreads(): LongOwnerThreads {
	const unanswered = ownerReviewThread(RECENT_COMMENTS + 1, {
		id: 'unanswered',
		isResolved: true,
	})
	const answered = ownerReviewThread(RECENT_COMMENTS + 1, {
		id: 'answered',
		isResolved: true,
	})
	return {
		unanswered,
		answered,
		answeredComments: [
			...answered.comments.nodes,
			markedThreadReply(),
			...(answered.latest?.nodes ?? []),
		],
	}
}
