import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { config, file } from '../../../shared/mocks/domain-test.helper'
import {
	ACCEPTING_RULES,
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
	getOwnerCleared,
	getPendingReply,
	isPastLimit,
	toDecidedReplies,
	toReplyItems,
	toResolvers,
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
		expect(getPendingReply(pendingBotThread(), [])).toEqual({
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
		expect(getPendingReply(thread, [])).toBeUndefined()
	})
	test('an unverified thread counts', () => {
		expect(
			getPendingReply(
				pendingBotThread({
					marker: { ...botThread().marker, kind: 'unverified' },
				}),
				[]
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
		if (thread) expect(getPendingReply(thread, [])).toBeUndefined()
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
			if (thread) expect(getPendingReply(thread, [])).toBeUndefined()
		}
	)
	test('an owner answer blocks a later user reply without a summary marker', () => {
		expect(
			getPendingReply(pendingBotThread({ sentToOwner: true }), [])
		).toBeUndefined()
		expect(
			getApplicableReplies(
				[decidedReply()],
				[pendingBotThread({ sentToOwner: true })],
				[]
			)
		).toEqual([])
	})
	test('a thread waiting for the owner is ignored', () => {
		expect(getPendingReply(pendingBotThread(), ['thread'])).toBeUndefined()
	})
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

describe('getOwnerCleared', () => {
	test.each([
		['admin', [], true],
		['write', ['CONTRIBUTOR'], true],
		['maintain', ['contributor'], true],
		['write', [], false],
		['read', ['contributor'], false],
		['triage', ['contributor'], false],
	] as const)('%s with allow %j clears=%s', (permission, allow, cleared) => {
		expect(
			getOwnerCleared(
				'Contributor',
				new Map([['contributor', { role_name: permission, permission }]]),
				allow
			)
		).toBe(cleared)
	})
	test('an unresolved GitHub thread does not retain its resolver', () => {
		expect(
			toResolvers([
				reviewThread(undefined, {
					isResolved: false,
					resolvedBy: { login: 'contributor' },
				}),
			])
		).toEqual(new Map())
	})
	test('missing role or resolver clears nothing', () => {
		expect(getOwnerCleared('contributor', new Map(), ['contributor'])).toBe(
			false
		)
		expect(getOwnerCleared(undefined, new Map(), ['contributor'])).toBe(false)
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
		expect(getApplicableReplies([decision], [thread], [])).toEqual([])
	})
	test('keeps a current decision once', () => {
		expect(
			getApplicableReplies(
				[decidedReply(), decidedReply()],
				[pendingBotThread()],
				[]
			)
		).toHaveLength(1)
	})
	test.each([
		decidedReply(undefined, { commentId: 41 }),
		decidedReply(undefined, { fingerprint: 'other' }),
		decidedReply(undefined, { threadId: 'unknown' }),
	])('drops stale or mismatched decisions %j', decision => {
		expect(getApplicableReplies([decision], [pendingBotThread()], [])).toEqual(
			[]
		)
	})
	test('drops a waiting thread', () => {
		expect(
			getApplicableReplies([decidedReply()], [pendingBotThread()], ['thread'])
		).toEqual([])
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

describe('isPastLimit', () => {
	test('critical in the bot marker stays past a critical configured limit', () => {
		expect(
			isPastLimit(
				pendingBotThread({
					marker: { ...botThread().marker, severity: 'critical' },
				}),
				config({ disputes: { accept_intentional_up_to: 'critical' } }),
				{ files: [] }
			)
		).toBe(true)
	})
	test.each([
		['low', false],
		['medium', false],
		['high', true],
	] as const)(
		'marker severity %s at a medium limit is past=%s',
		(severity, expected) => {
			expect(
				isPastLimit(
					pendingBotThread({ marker: { ...botThread().marker, severity } }),
					config({ disputes: { accept_intentional_up_to: 'medium' } }),
					{ files: [] }
				)
			).toBe(expected)
		}
	)
	test('high at the configured high limit is allowed', () => {
		expect(
			isPastLimit(pendingBotThread(), ACCEPTING_RULES.config, { files: [] })
		).toBe(false)
	})
	test('the current thread path under risk_paths is past the limit', () => {
		expect(
			isPastLimit(
				pendingBotThread(),
				{
					...ACCEPTING_RULES.config,
					risk_paths: ['src/**'],
				},
				{ files: [file(bug().path)] }
			)
		).toBe(true)
	})
	test('a renamed file at its old risk path is past the limit', () => {
		expect(
			isPastLimit(
				pendingBotThread(),
				{
					...ACCEPTING_RULES.config,
					risk_paths: ['src/risk/**'],
				},
				{
					files: [
						file(bug().path, {
							status: 'renamed',
							oldPath: 'src/risk/store.ts',
						}),
					],
				}
			)
		).toBe(true)
	})
	test('a neighboring path outside risk_paths is allowed', () => {
		expect(
			isPastLimit(
				pendingBotThread({ path: 'src/risks/store.ts' }),
				{
					...ACCEPTING_RULES.config,
					risk_paths: ['src/risk/**'],
				},
				{ files: [] }
			)
		).toBe(false)
	})
	test('a failed git read is past the limit even with accepting rules', () => {
		expect(
			isPastLimit(pendingBotThread(), ACCEPTING_RULES.config, undefined)
		).toBe(true)
	})
})
