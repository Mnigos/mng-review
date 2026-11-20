import type { ReplyApplyInput } from '../../modules/publish/application/thread-reply.service'
import { toBodyDigest } from '../../modules/publish/domain/bot-thread.helper'
import type { BotThread } from '../../modules/publish/domain/publish.types'
import type {
	DecidedThreadReply,
	PendingReply,
	ThreadReplyDecision,
} from '../../modules/publish/domain/thread-reply.schema'
import type { ReviewThread } from '../../platform/github-api.schema'
import { config } from './domain-test.helper'
import { botThread, reviewThread } from './publish-test.helper'

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

/** The default rules and an empty change, for `apply`'s limit check. */
export function replyRules(): Pick<ReplyApplyInput, 'config' | 'change'> {
	return { config: config(), change: { files: [] } }
}
