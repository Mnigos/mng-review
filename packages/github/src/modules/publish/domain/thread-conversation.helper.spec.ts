import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import {
	APP_IDENTITY,
	bug,
	botThread,
	reviewThread,
	threadReply,
} from '../../../shared/mocks/publish-test.helper'
import {
	decidedReply,
	pendingBotThread,
	pendingReply,
	pendingReviewThread,
} from '../../../shared/mocks/thread-reply-test.helper'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import { toBodyDigest, toBotThread } from './bot-thread.helper'
import { MARKER_VERSION } from './publish.constants'
import {
	countDisputes,
	getApplicableReplies,
	getPendingReply,
	toDecidedReplies,
	toReplyItems,
} from './thread-conversation.helper'

const OWNED = [GITHUB_ACTIONS_IDENTITY] as const
const SHA = 'a'.repeat(40)
const DISPUTED = toMarkerComment('reply', {
	v: MARKER_VERSION,
	action: 'disputed',
	commit: SHA,
	reply: 41,
})

describe('getPendingReply', () => {
	test('the latest user comment counts', () => {
		expect(getPendingReply(pendingBotThread())).toEqual({
			commentId: 42,
			author: 'contributor',
		})
	})
	test.each([
		pendingBotThread({
			latestAuthor: { type: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
		}),
		pendingBotThread({ latestAuthor: undefined }),
		pendingBotThread({ latestCommentId: undefined }),
		pendingBotThread({ replies: 0 }),
		pendingBotThread({ resolved: true }),
		pendingBotThread({ marker: { ...botThread().marker, kind: 'nit' } }),
	])('ineligible latest comment or thread is ignored: %j', thread => {
		expect(getPendingReply(thread)).toBeUndefined()
	})
	test('an unverified thread counts', () => {
		expect(
			getPendingReply(
				pendingBotThread({
					marker: { ...botThread().marker, kind: 'unverified' },
				})
			)
		).toBeDefined()
	})
	test('a user copying a bot marker cannot create a pending reply', () => {
		const raw = pendingReviewThread({
			latest: {
				nodes: [
					threadReply({
						body: DISPUTED,
						author: { __typename: 'User', login: 'contributor' },
					}),
				],
			},
		})
		const thread = toBotThread(raw, OWNED)
		expect(thread).toBeDefined()
		if (thread) expect(getPendingReply(thread)).toBeUndefined()
	})
	test.each(['resolved', 'accepted'] as const)(
		'an owned %s answer closes the thread for the bot',
		action => {
			const raw = reviewThread()
			const thread = toBotThread(
				{
					...raw,
					comments: { ...raw.comments, totalCount: 2 },
					latest: {
						nodes: [
							threadReply({
								body: toMarkerComment('reply', {
									v: MARKER_VERSION,
									action,
									commit: SHA,
									reply: 42,
								}),
							}),
						],
					},
				},
				OWNED
			)
			expect(thread).toMatchObject({ resolved: true, closedByBot: true })
			if (thread) expect(getPendingReply(thread)).toBeUndefined()
		}
	)
})

describe('countDisputes', () => {
	test('counts only owned bot markers unchanged by another identity', () => {
		expect(
			countDisputes(
				[
					threadReply({ body: DISPUTED }),
					threadReply({
						body: DISPUTED,
						editor: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
					}),
					threadReply({
						body: DISPUTED,
						author: { __typename: 'User', login: 'contributor' },
					}),
					threadReply({
						body: DISPUTED,
						editor: { __typename: 'User', login: 'contributor' },
					}),
					threadReply({
						body: DISPUTED,
						author: { __typename: 'Bot', login: APP_IDENTITY.login },
					}),
					threadReply(),
				],
				OWNED
			)
		).toBe(2)
	})
})

describe('toReplyItems', () => {
	test('binds the finding, original commit and reply body', () => {
		expect(
			toReplyItems([pendingReply()], [pendingBotThread({ commit: SHA })])
		).toMatchObject([
			{
				reply: pendingReply(),
				item: {
					base: SHA,
					reply: pendingReply().body,
					disputes: 0,
					finding: { path: botThread().path },
				},
			},
		])
	})
	test.each([
		pendingBotThread({ commit: 'main' }),
		pendingBotThread({ commit: undefined }),
		pendingBotThread({ commit: SHA, path: '/src/store.ts' }),
		pendingBotThread({ commit: SHA, path: '../store.ts' }),
		pendingBotThread({
			commit: SHA,
			marker: { ...botThread().marker, fingerprint: 'other' },
		}),
	])('drops unsafe or mismatched thread %j', thread => {
		expect(toReplyItems([pendingReply()], [thread])).toEqual([])
	})
	test('drops an unknown thread', () => {
		expect(toReplyItems([pendingReply()], [])).toEqual([])
	})
})

describe('getApplicableReplies', () => {
	test('drops an edited reply even when its comment id and fingerprint match', () => {
		const decision = decidedReply()
		const thread = pendingBotThread({
			latestDigest: toBodyDigest('edited reply'),
		})
		expect(thread.latestCommentId).toBe(decision.commentId)
		expect(thread.marker.fingerprint).toBe(decision.fingerprint)
		expect(getApplicableReplies([decision], [thread])).toEqual([])
	})
	test('keeps a current decision once', () => {
		expect(
			getApplicableReplies(
				[decidedReply(), decidedReply()],
				[pendingBotThread()]
			)
		).toHaveLength(1)
	})
	test.each([
		decidedReply(undefined, { commentId: 41 }),
		decidedReply(undefined, { fingerprint: 'other' }),
		decidedReply(undefined, { threadId: 'unknown' }),
	])('drops stale or mismatched decisions %j', decision => {
		expect(getApplicableReplies([decision], [pendingBotThread()])).toEqual([])
	})
})

describe('toDecidedReplies', () => {
	test('carries each whole-body digest into its decision without the reply text', () => {
		const reply = pendingReply({
			body: 'fixed',
			digest: toBodyDigest('fixed with text beyond the cutoff'),
		})
		const pairs = toReplyItems([reply], [pendingBotThread({ commit: SHA })])
		expect(
			toDecidedReplies(pairs, [
				{
					finding: bug(),
					base: SHA,
					reply: reply.body,
					disputes: 0,
					decision: { action: 'seen' },
				},
			])
		).toEqual([decidedReply(undefined, { digest: reply.digest })])
	})
	test('omits errored engine results while preserving the positional binding', () => {
		const pairs = toReplyItems(
			[pendingReply(), pendingReply({ threadId: 'second', commentId: 43 })],
			[
				pendingBotThread({ commit: SHA }),
				pendingBotThread({ id: 'second', commit: SHA }),
			]
		)
		expect(
			toDecidedReplies(pairs, [
				{
					finding: bug(),
					base: SHA,
					reply: 'fixed',
					disputes: 0,
					decision: { action: 'seen' },
					error: 'offline',
				},
				{
					finding: bug(),
					base: SHA,
					reply: 'fixed',
					disputes: 0,
					decision: { action: 'seen' },
				},
			])
		).toEqual([decidedReply(undefined, { threadId: 'second', commentId: 43 })])
	})
})
