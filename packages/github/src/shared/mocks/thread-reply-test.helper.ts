import type { BotThread } from '../../modules/publish/domain/publish.types'
import type {
	DecidedThreadReply,
	PendingReply,
	ThreadReplyDecision,
} from '../../modules/publish/domain/thread-reply.schema'
import type { ReviewThread } from '../../platform/github-api.schema'
import { botThread, reviewThread } from './publish-test.helper'

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
					body: 'fixed after the guard',
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
		author: 'contributor',
		body: 'fixed after the guard',
		disputes: 0,
		...overrides,
	}
}

const SEEN = { action: 'seen' } as const satisfies ThreadReplyDecision

/** A decision bound to the shared pending reply. */
export function decidedReply(
	decision: ThreadReplyDecision = SEEN,
	overrides: Partial<DecidedThreadReply> = {}
): DecidedThreadReply {
	const { threadId, fingerprint, commentId } = pendingReply()
	return { threadId, fingerprint, commentId, decision, ...overrides }
}
