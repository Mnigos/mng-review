import { layer } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { RECENT_COMMENTS } from '../../../platform/github-api.constants'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubApiError } from '../../../platform/github.errors'
import { config, file } from '../../../shared/mocks/domain-test.helper'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { HOSTILE_TEXT } from '../../../shared/mocks/hostile-text.helper'
import {
	ACCEPTING_RULES,
	botThread,
	bug,
	reviewThread,
	LINKS,
	TOKEN_MODE_OWNED,
	threadReply,
} from '../../../shared/mocks/publish-test.helper'
import {
	ACCEPTED_DECISION,
	editedOwnerReviewThread,
	markedThreadReply,
	decidedReply,
	pendingBotThread,
	pendingReply,
	pendingReviewThread,
	ownerReviewThread,
	rawThread,
	replyRules,
} from '../../../shared/mocks/thread-reply-test.helper'
import { parseMentionCommand } from '../../command/domain/mention-command.parser'
import { toBodyDigest, toBotThread } from '../domain/bot-thread.helper'
import { parseReplyMarker } from '../domain/publish-marker.parser'
import {
	MARKER_VERSION,
	MAX_REPLY_CHARS,
	MAX_REPLY_THREADS,
	NEEDS_OWNER_LABEL,
	SHORT_SHA_LENGTH,
} from '../domain/publish.constants'
import { toResolvers } from '../domain/thread-conversation.helper'
import type { ThreadReplyDecision } from '../domain/thread-reply.schema'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import {
	ThreadReplyService,
	ThreadReplyServiceLive,
} from './thread-reply.service'

/** Recording API and service with no network layer. */
function setup() {
	const fake = githubApiFake()
	fake.command.role = 'write'
	fake.threads.push(pendingReviewThread())
	return { fake }
}

/** A rejected GitHub operation. */
function apiError(status = 503) {
	return new GitHubApiError({ operation: 'reply', reason: 'denied', status })
}

const DECISIONS = [
	{ action: 'resolved', reason: 'The write is guarded.' },
	ACCEPTED_DECISION,
	{ action: 'still-found', reason: 'The write repeats.' },
	{ action: 'disputed', reason: 'The premise is false.' },
	{ action: 'needs-owner', reason: 'The disagreement remains.' },
	{ action: 'seen' },
] as const satisfies readonly ThreadReplyDecision[]
const TEXTS = {
	resolved: 'No longer found',
	accepted: 'Accepted as intentional',
	'still-found': `Still found at \`${LINKS.head.slice(0, SHORT_SHA_LENGTH)}\``,
	disputed: 'A second disagreement goes to the owner',
	'needs-owner': 'This goes to the owner',
	seen: 'Seen. Reply `fixed`',
} as const

layer(TOKEN_MODE_OWNED)('ThreadReplyService collect', test => {
	test.effect(
		'edits beyond the body cutoff change the digest while the prepared body stays the same',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				const service = yield* ThreadReplyService.pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
				const prefix = 'x'.repeat(MAX_REPLY_CHARS)
				const collect = (suffix: string) => {
					fake.threadComments.set('thread', [
						threadReply({
							databaseId: 42,
							body: prefix + suffix,
							author: { __typename: 'User', login: 'contributor' },
						}),
					])
					return service.collect({
						pullNumber: 17,
						threads: [pendingBotThread()],
						rotation: 0,
						waiting: [],
					})
				}
				const before = yield* collect('before')
				const after = yield* collect('after')
				expect(before).toEqual([
					pendingReply({
						body: prefix,
						digest: toBodyDigest(`${prefix}before`),
					}),
				])
				expect(after).toEqual([
					pendingReply({
						body: prefix,
						digest: toBodyDigest(`${prefix}after`),
					}),
				])
				expect(before[0]?.digest).not.toBe(after[0]?.digest)
			})
	)
	for (const role of ['read', 'triage', 'write', 'maintain', 'admin'])
		test.effect(`only writers count: ${role}`, () =>
			Effect.gen(function* () {
				const { fake } = setup()
				fake.command.role = role
				const replies = yield* ThreadReplyService.use(service =>
					service.collect({
						pullNumber: 17,
						threads: [pendingBotThread()],
						rotation: 0,
						waiting: [],
					})
				).pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
				expect(replies).toEqual(
					['write', 'maintain', 'admin'].includes(role) ? [pendingReply()] : []
				)
				expect(
					fake.reads.filter(read => read.startsWith('listThreadComments'))
				).toHaveLength(replies.length)
			})
		)
	for (const operation of [
		'getCollaboratorRole',
		'listThreadComments',
	] as const)
		test.effect(`a failed ${operation} leaves the reply out`, () =>
			Effect.gen(function* () {
				const { fake } = setup()
				fake.failures[operation].push(apiError())
				expect(
					yield* ThreadReplyService.use(service =>
						service.collect({
							pullNumber: 17,
							threads: [pendingBotThread()],
							rotation: 0,
							waiting: [],
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toEqual([])
			})
		)
	test.effect(
		'nine replies give eight and the next rotation includes the ninth',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				const threads = Array.from(
					{ length: MAX_REPLY_THREADS + 1 },
					(_, index) => pendingBotThread({ id: `thread-${index}` })
				)
				for (const thread of threads)
					fake.threads.push(pendingReviewThread({ id: thread.id }))
				const service = yield* ThreadReplyService.pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
				const first = yield* service.collect({
					pullNumber: 17,
					threads,
					rotation: 0,
					waiting: [],
				})
				const next = yield* service.collect({
					pullNumber: 17,
					threads,
					rotation: 1,
					waiting: [],
				})
				expect(first).toHaveLength(MAX_REPLY_THREADS)
				expect(next).toHaveLength(MAX_REPLY_THREADS)
				expect(
					new Set([...first, ...next].map(reply => reply.threadId))
				).toHaveLength(threads.length)
				expect(
					next.some(
						reply =>
							!first.some(previous => previous.threadId === reply.threadId)
					)
				).toBeTruthy()
			})
	)
	test.effect(
		'cuts the body and counts earlier disputes from the full comment list',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				fake.threadComments.set('thread', [
					threadReply({
						body: `Earlier dispute\n${toMarkerComment('reply', { v: MARKER_VERSION, action: 'disputed', commit: LINKS.head })}`,
					}),
					threadReply({
						databaseId: 42,
						body: 'x'.repeat(MAX_REPLY_CHARS + 20),
						author: { __typename: 'User', login: 'contributor' },
					}),
				])
				expect(
					yield* ThreadReplyService.use(service =>
						service.collect({
							pullNumber: 17,
							threads: [pendingBotThread()],
							rotation: 0,
							waiting: [],
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toEqual([
					pendingReply({
						body: 'x'.repeat(MAX_REPLY_CHARS),
						digest: toBodyDigest('x'.repeat(MAX_REPLY_CHARS + 20)),
						disputes: 1,
					}),
				])
			})
	)
	test.effect(
		'drops the reply when the full list ends with another comment',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				fake.threadComments.set('thread', [threadReply({ databaseId: 43 })])
				expect(
					yield* ThreadReplyService.use(service =>
						service.collect({
							pullNumber: 17,
							threads: [pendingBotThread()],
							rotation: 0,
							waiting: [],
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toEqual([])
			})
	)
})

layer(TOKEN_MODE_OWNED)('ThreadReplyService apply', test => {
	for (const scenario of [
		{
			name: 'critical marker severity',
			config: {
				...ACCEPTING_RULES.config,
				disputes: {
					...ACCEPTING_RULES.config.disputes,
					accept_intentional_up_to: 'critical',
				},
			},
			change: replyRules().change,
			thread: pendingBotThread({
				marker: { ...botThread().marker, severity: 'critical' },
			}),
		},
		{
			name: 'a current path under risk_paths',
			config: { ...ACCEPTING_RULES.config, risk_paths: ['src/**'] },
			change: { files: [file(bug().path)] },
			thread: pendingBotThread(),
		},
		{
			name: 'an old rename path under risk_paths',
			config: { ...ACCEPTING_RULES.config, risk_paths: ['src/risk/**'] },
			change: {
				files: [
					file(bug().path, { status: 'renamed', oldPath: 'src/risk/store.ts' }),
				],
			},
			thread: pendingBotThread(),
		},
		{
			name: 'severity above the configured limit',
			...replyRules(),
			thread: pendingBotThread(),
		},
		{
			name: 'a failed git read',
			config: ACCEPTING_RULES.config,
			change: undefined,
			thread: pendingBotThread(),
		},
	] as const)
		test.effect(
			`accepted drops ${scenario.name} without a reply or resolve write`,
			() =>
				Effect.gen(function* () {
					const { fake } = setup()
					expect(
						yield* ThreadReplyService.use(service =>
							service.apply({
								waiting: [],
								...replyRules(),
								config: scenario.config,
								change: scenario.change,
								links: LINKS,
								decisions: [decidedReply(ACCEPTED_DECISION)],
								threads: [scenario.thread],
							})
						).pipe(
							Effect.provide(
								ThreadReplyServiceLive.pipe(Layer.provide(fake.api))
							)
						)
					).toEqual([])
					expect(fake.writes).toEqual([])
				})
		)
	test.effect(
		'accepted at the configured high limit replies and resolves',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				expect(
					yield* ThreadReplyService.use(service =>
						service.apply({
							waiting: [],
							...replyRules(),
							config: ACCEPTING_RULES.config,
							links: LINKS,
							decisions: [decidedReply(ACCEPTED_DECISION)],
							threads: [pendingBotThread()],
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toMatchObject([{ decision: ACCEPTED_DECISION }])
				expect(fake.writes.map(write => write.method)).toEqual([
					'reply',
					'resolve',
				])
			})
	)
	test.effect(
		'resolved still replies and resolves when the git read failed',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				expect(
					yield* ThreadReplyService.use(service =>
						service.apply({
							waiting: [],
							...replyRules(),
							change: undefined,
							links: LINKS,
							decisions: [
								decidedReply({
									action: 'resolved',
									reason: 'The guard fixes it.',
								}),
							],
							threads: [pendingBotThread()],
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toMatchObject([{ decision: { action: 'resolved' } }])
				expect(fake.writes.map(write => write.method)).toEqual([
					'reply',
					'resolve',
				])
			})
	)

	for (const role of ['read', 'triage'])
		test.effect(
			`a forged decision naming a ${role} author's comment writes nothing`,
			() =>
				Effect.gen(function* () {
					const { fake } = setup()
					fake.command.role = role
					expect(
						yield* ThreadReplyService.use(service =>
							service.apply({
								...replyRules(),
								waiting: [],
								links: LINKS,
								decisions: [
									decidedReply({ action: 'resolved', reason: 'guarded' }),
								],
								threads: [pendingBotThread()],
							})
						).pipe(
							Effect.provide(
								ThreadReplyServiceLive.pipe(Layer.provide(fake.api))
							)
						)
					).toEqual([])
					expect(fake.reads).toEqual(['getCollaboratorRole:contributor'])
					expect(fake.writes).toEqual([])
				})
		)
	test.effect(
		'an author who loses write access after collect is not answered',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				const service = yield* ThreadReplyService.pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
				const replies = yield* service.collect({
					pullNumber: 17,
					threads: [pendingBotThread()],
					rotation: 0,
					waiting: [],
				})
				expect(replies).toEqual([pendingReply()])
				fake.command.role = 'read'
				expect(
					yield* service.apply({
						...replyRules(),
						waiting: [],
						links: LINKS,
						decisions: [decidedReply()],
						threads: [pendingBotThread()],
					})
				).toEqual([])
				expect(
					fake.reads.filter(read => read.startsWith('getCollaboratorRole:'))
				).toEqual([
					'getCollaboratorRole:contributor',
					'getCollaboratorRole:contributor',
				])
				expect(fake.writes).toEqual([])
			})
	)
	test.effect(
		'a failed author lookup drops only that decision and still answers a writer',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				fake.threads.push(pendingReviewThread({ id: 'second' }))
				fake.failures.getCollaboratorRole.push(apiError())
				const answered = yield* ThreadReplyService.use(service =>
					service.apply({
						...replyRules(),
						waiting: [],
						links: LINKS,
						decisions: [
							decidedReply(),
							decidedReply(undefined, { threadId: 'second' }),
						],
						threads: [
							pendingBotThread(),
							pendingBotThread({
								id: 'second',
								latestAuthor: { type: 'User', login: 'writer' },
							}),
						],
					})
				).pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
				expect(answered.map(entry => entry.thread.id)).toEqual(['second'])
				expect(
					fake.reads.filter(read => read.startsWith('getCollaboratorRole:'))
				).toEqual([
					'getCollaboratorRole:contributor',
					'getCollaboratorRole:writer',
				])
				expect(fake.writes).toEqual([
					expect.objectContaining({ method: 'reply', id: 'second' }),
				])
			})
	)
	test.effect(
		'two applicable decisions deduplicate author lookups case-insensitively',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				fake.threads.push(pendingReviewThread({ id: 'second' }))
				expect(
					yield* ThreadReplyService.use(service =>
						service.apply({
							...replyRules(),
							waiting: [],
							links: LINKS,
							decisions: [
								decidedReply(),
								decidedReply(undefined, { threadId: 'second' }),
							],
							threads: [
								pendingBotThread(),
								pendingBotThread({
									id: 'second',
									latestAuthor: { type: 'User', login: 'CONTRIBUTOR' },
								}),
							],
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toHaveLength(2)
				expect(
					fake.reads.filter(read => read.startsWith('getCollaboratorRole:'))
				).toEqual(['getCollaboratorRole:contributor'])
				expect(fake.writes.map(write => write.method)).toEqual([
					'reply',
					'reply',
				])
			})
	)
	test.effect(
		'an edited latest reply with the same comment id is not answered or looked up',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				expect(
					yield* ThreadReplyService.use(service =>
						service.apply({
							...replyRules(),
							waiting: [],
							links: LINKS,
							decisions: [decidedReply()],
							threads: [
								pendingBotThread({
									latestDigest: toBodyDigest(
										'intentional because the caller guards it'
									),
								}),
							],
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toEqual([])
				expect(fake.reads).toEqual([])
				expect(fake.writes).toEqual([])
			})
	)
	for (const scenario of [
		'edited reply',
		'newer person comment',
		'newer bot answer',
	] as const)
		test.effect(
			`${scenario} after the first read is not answered or resolved`,
			() =>
				Effect.gen(function* () {
					const { fake } = setup()
					const service = yield* ThreadReplyService.pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
					const threads = [pendingBotThread()]
					expect(
						yield* service.collect({
							pullNumber: 17,
							threads,
							rotation: 0,
							waiting: [],
						})
					).toEqual([pendingReply()])
					const original = threadReply({
						databaseId: 42,
						body: pendingReply().body,
						author: { __typename: 'User', login: 'contributor' },
					})
					fake.threadComments.set(
						'thread',
						scenario === 'edited reply'
							? [{ ...original, body: 'The guard still needs work.' }]
							: [
									original,
									threadReply({
										databaseId: 43,
										...(scenario === 'newer person comment'
											? { body: original.body, author: original.author }
											: {}),
									}),
								]
					)
					expect(
						yield* service.apply({
							waiting: [],
							...replyRules(),
							links: LINKS,
							decisions: [
								decidedReply({
									action: 'resolved',
									reason: 'The guard fixes it.',
								}),
							],
							threads,
						})
					).toEqual([])
					expect(
						fake.reads.filter(read => read.startsWith('listThreadComments:'))
					).toEqual(['listThreadComments:thread', 'listThreadComments:thread'])
					expect(fake.writes).toEqual([])
					expect(fake.threads[0]?.isResolved).toBe(false)
				})
		)
	test.effect(
		'a failed comment re-read skips only that thread and answers the next',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				fake.threads.push(pendingReviewThread({ id: 'second' }))
				const service = yield* ThreadReplyService.pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
				const threads = [pendingBotThread(), pendingBotThread({ id: 'second' })]
				expect(
					yield* service.collect({
						pullNumber: 17,
						threads,
						rotation: 0,
						waiting: [],
					})
				).toEqual([pendingReply(), pendingReply({ threadId: 'second' })])
				fake.failures.listThreadComments.push(apiError())
				const decision = {
					action: 'resolved',
					reason: 'The guard fixes it.',
				} as const satisfies ThreadReplyDecision
				expect(
					yield* service.apply({
						waiting: [],
						...replyRules(),
						links: LINKS,
						decisions: [
							decidedReply(decision),
							decidedReply(decision, { threadId: 'second' }),
						],
						threads,
					})
				).toMatchObject([{ thread: { id: 'second' }, commentId: 42, decision }])
				expect(
					fake.reads.filter(read => read.startsWith('listThreadComments:'))
				).toEqual([
					'listThreadComments:thread',
					'listThreadComments:second',
					'listThreadComments:thread',
					'listThreadComments:second',
				])
				expect(fake.failures.listThreadComments).toEqual([])
				expect(fake.writes).toEqual([
					expect.objectContaining({ method: 'reply', id: 'second' }),
					{ method: 'resolve', id: 'second' },
				])
				expect(fake.threads[0]?.isResolved).toBe(false)
			})
	)
	test.effect(
		'an unchanged reply is re-read before the answer and resolve writes',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				const service = yield* ThreadReplyService.pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
				const threads = [pendingBotThread()]
				expect(
					yield* service.collect({
						pullNumber: 17,
						threads,
						rotation: 0,
						waiting: [],
					})
				).toEqual([pendingReply()])
				const pushReadsSpy = vi.spyOn(fake.reads, 'push')
				const pushWritesSpy = vi.spyOn(fake.writes, 'push')
				const decision = {
					action: 'resolved',
					reason: 'The guard fixes it.',
				} as const satisfies ThreadReplyDecision
				expect(
					yield* service.apply({
						waiting: [],
						...replyRules(),
						links: LINKS,
						decisions: [decidedReply(decision)],
						threads,
					})
				).toMatchObject([{ thread: { id: 'thread' }, commentId: 42, decision }])
				expect(pushReadsSpy.mock.calls).toEqual([
					['getCollaboratorRole:contributor'],
					['listThreadComments:thread'],
				])
				expect(fake.writes).toEqual([
					expect.objectContaining({ method: 'reply', id: 'thread' }),
					{ method: 'resolve', id: 'thread' },
				])
				expect(pushReadsSpy.mock.invocationCallOrder.at(-1)).toBeLessThan(
					pushWritesSpy.mock.invocationCallOrder[0] ?? 0
				)
				expect(pushWritesSpy.mock.invocationCallOrder[0]).toBeLessThan(
					pushWritesSpy.mock.invocationCallOrder[1] ?? 0
				)
			})
	)

	for (const decision of DECISIONS)
		test.effect(
			`${decision.action} writes its text and the answered comment marker`,
			() =>
				Effect.gen(function* () {
					const { fake } = setup()
					const answered = yield* ThreadReplyService.use(service =>
						service.apply({
							...replyRules(),
							...(decision.action === 'accepted'
								? { config: ACCEPTING_RULES.config }
								: {}),
							links: LINKS,
							waiting: [],
							decisions: [decidedReply(decision)],
							threads: [pendingBotThread()],
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
					expect(answered).toMatchObject([{ commentId: 42, decision }])
					const write = fake.writes.find(entry => entry.method === 'reply')
					expect(write?.method).toBe('reply')
					if (write?.method === 'reply') {
						expect(write.body).toContain(TEXTS[decision.action])
						if (decision.action === 'needs-owner')
							expect(write.body).toContain(
								'The bot no longer answers in this thread. An admin, or a login in `commands.allow`, resolves it to clear the pull request.'
							)
						if ('reason' in decision)
							expect(write.body).toContain(decision.reason)
						expect(parseReplyMarker(write.body)).toEqual({
							v: MARKER_VERSION,
							action: decision.action,
							commit: LINKS.head,
							reply: 42,
						})
					}
					expect(
						fake.writes.filter(entry => entry.method === 'resolve')
					).toEqual(
						['accepted', 'resolved'].includes(decision.action)
							? [{ method: 'resolve', id: 'thread' }]
							: []
					)
				})
		)
	for (const invalid of [
		'stale',
		'fingerprint',
		'unknown',
		'foreign',
		'waiting',
	] as const)
		test.effect(`a ${invalid} decision writes nothing`, () =>
			Effect.gen(function* () {
				const { fake } = setup()
				const decision = decidedReply(
					undefined,
					invalid === 'stale'
						? { commentId: 41 }
						: invalid === 'fingerprint'
							? { fingerprint: 'other' }
							: invalid === 'unknown'
								? { threadId: 'other' }
								: {}
				)
				const foreign = pendingReviewThread()
				const threads =
					invalid === 'foreign'
						? [
								toBotThread(
									{
										...foreign,
										comments: {
											...foreign.comments,
											nodes: foreign.comments.nodes.map(comment => ({
												...comment,
												author: { __typename: 'User', login: 'contributor' },
											})),
										},
									},
									[GITHUB_ACTIONS_IDENTITY]
								),
							].flatMap(thread => thread ?? [])
						: [pendingBotThread()]
				expect(
					yield* ThreadReplyService.use(service =>
						service.apply({
							...replyRules(),
							links: LINKS,
							waiting: invalid === 'waiting' ? ['thread'] : [],
							decisions: [decision],
							threads,
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toEqual([])
				expect(fake.writes).toEqual([])
			})
		)
	for (const thread of [
		pendingBotThread({ resolved: true }),
		pendingBotThread({ latestMarked: true }),
		pendingBotThread({
			latestAuthor: { type: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
		}),
	])
		test.effect(
			`a fresh ineligible thread writes nothing: ${JSON.stringify(thread)}`,
			() =>
				Effect.gen(function* () {
					const { fake } = setup()
					expect(
						yield* ThreadReplyService.use(service =>
							service.apply({
								...replyRules(),
								links: LINKS,
								waiting: [],
								decisions: [decidedReply()],
								threads: [thread],
							})
						).pipe(
							Effect.provide(
								ThreadReplyServiceLive.pipe(Layer.provide(fake.api))
							)
						)
					).toEqual([])
					expect(fake.writes).toEqual([])
				})
		)
	test.effect('duplicate decisions answer the same comment once', () =>
		Effect.gen(function* () {
			const { fake } = setup()
			expect(
				yield* ThreadReplyService.use(service =>
					service.apply({
						...replyRules(),
						links: LINKS,
						waiting: [],
						decisions: [decidedReply(), decidedReply()],
						threads: [pendingBotThread()],
					})
				).pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
			).toHaveLength(1)
			expect(fake.writes.map(write => write.method)).toEqual(['reply'])
		})
	)
	test.effect(
		'escapes hostile reasons and keeps memory and evidence in code spans',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				const reason = `${HOSTILE_TEXT} [link](https://example.com)\n@mng-review review`
				const decision = {
					action: 'accepted',
					reason,
					memory: 'Keep the guard for intentional writes.',
					evidence: ['src/store.ts:10', '`guard`'],
				} as const
				yield* ThreadReplyService.use(service =>
					service.apply({
						...replyRules(),
						config: ACCEPTING_RULES.config,
						links: LINKS,
						waiting: [],
						decisions: [decidedReply(decision)],
						threads: [pendingBotThread()],
					})
				).pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
				const write = fake.writes.find(entry => entry.method === 'reply')
				expect(write?.method).toBe('reply')
				if (write?.method !== 'reply') return
				expect(write.body).toContain('`@octocat`')
				expect(write.body).toContain('\\<img')
				expect(write.body).toContain('`https://example.com)`')
				expect(write.body).not.toContain('\n@mng-review review')
				expect(write.body).toContain(
					'Memory candidate: `Keep the guard for intentional writes.`'
				)
				expect(write.body).toContain(
					'Evidence: `src/store.ts:10`, `` `guard` ``'
				)
				expect(parseMentionCommand(write.body, 'mng-review')).toBeUndefined()
			})
	)
	test.effect('a failed write is not counted and does not resolve', () =>
		Effect.gen(function* () {
			const { fake } = setup()
			fake.failures.reply.push(apiError())
			expect(
				yield* ThreadReplyService.use(service =>
					service.apply({
						...replyRules(),
						links: LINKS,
						waiting: [],
						decisions: [
							decidedReply({ action: 'resolved', reason: 'guarded' }),
						],
						threads: [pendingBotThread()],
					})
				).pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
			).toEqual([])
			expect(fake.writes.some(entry => entry.method === 'resolve')).toBe(false)
		})
	)
	test.effect('a refused resolve still counts the closing answer', () =>
		Effect.gen(function* () {
			const { fake } = setup()
			fake.failures.resolve.push(apiError(403))
			expect(
				yield* ThreadReplyService.use(service =>
					service.apply({
						...replyRules(),
						links: LINKS,
						waiting: [],
						decisions: [
							decidedReply({ action: 'resolved', reason: 'guarded' }),
						],
						threads: [pendingBotThread()],
					})
				).pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
			).toHaveLength(1)
		})
	)
	test.effect(
		'the next overlapping run reads the bot answer and never answers twice',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				const resolveStarted = yield* Deferred.make<void>()
				const finishResolve = yield* Deferred.make<void>()
				const recordingApi = yield* GitHubApiService.pipe(
					Effect.provide(fake.api)
				)
				const resolvingApi = Layer.succeed(GitHubApiService, {
					...recordingApi,
					resolveThread: id =>
						Deferred.succeed(resolveStarted, undefined).pipe(
							Effect.andThen(Deferred.await(finishResolve)),
							Effect.andThen(recordingApi.resolveThread(id))
						),
				})
				const service = yield* ThreadReplyService.pipe(
					Effect.provide(
						ThreadReplyServiceLive.pipe(Layer.provide(resolvingApi))
					)
				)
				const input = {
					...replyRules(),
					links: LINKS,
					waiting: [],
					decisions: [
						decidedReply({ action: 'resolved', reason: 'The guard fixes it.' }),
					],
					threads: [pendingBotThread()],
				}
				const firstRun = yield* service.apply(input).pipe(Effect.forkChild)
				yield* Deferred.await(resolveStarted)
				expect(fake.threads[0]?.isResolved).toBe(false)
				const fresh = yield* GitHubApiService.use(api =>
					api.listReviewThreads(17)
				).pipe(Effect.provide(fake.api))
				expect(
					yield* service.apply({
						...replyRules(),
						...input,
						threads: fresh.flatMap(
							thread => toBotThread(thread, [GITHUB_ACTIONS_IDENTITY]) ?? []
						),
					})
				).toEqual([])
				yield* Deferred.succeed(finishResolve, undefined)
				expect(yield* Fiber.join(firstRun)).toHaveLength(1)
				expect(
					fake.writes.filter(entry => entry.method === 'reply')
				).toHaveLength(1)
			})
	)
})

layer(TOKEN_MODE_OWNED)('ThreadReplyService syncLabel', test => {
	for (const [before, after, failure, expected] of [
		[0, 1, undefined, 'added'],
		[1, 2, undefined, 'added'],
		[1, 0, undefined, 'removed'],
		[1, 0, 404, 'removed'],
		[1, 0, 503, 'failed'],
		[0, 1, 403, 'failed'],
		[0, 1, 503, 'failed'],
		[1, 0, 403, 'failed'],
		[0, 0, undefined, 'none'],
	] as const)
		test.effect(
			`${before} to ${after}, failure=${failure} gives ${expected}`,
			() =>
				Effect.gen(function* () {
					const { fake } = setup()
					if (failure)
						fake.failures[after > 0 ? 'label' : 'unlabel'].push(
							apiError(failure)
						)
					expect(
						yield* ThreadReplyService.use(service =>
							service.syncLabel(17, before, after)
						).pipe(
							Effect.provide(
								ThreadReplyServiceLive.pipe(Layer.provide(fake.api))
							)
						)
					).toBe(expected)
					expect(fake.writes).toEqual(
						expected === 'none'
							? []
							: [
									{
										method: after > 0 ? 'label' : 'unlabel',
										pullNumber: 17,
										name: NEEDS_OWNER_LABEL,
									},
								]
					)
				})
		)
})

layer(TOKEN_MODE_OWNED)('ThreadReplyService owner waiting', test => {
	test.effect(
		'collect skips a waiting thread before any role or comment read',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				expect(
					yield* ThreadReplyService.use(service =>
						service.collect({
							pullNumber: 17,
							threads: [pendingBotThread()],
							rotation: 0,
							waiting: ['thread'],
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toEqual([])
				expect(fake.reads).toEqual([])
				expect(fake.writes).toEqual([])
			})
	)
	test.effect('a failed resolver role lookup clears nothing', () =>
		Effect.gen(function* () {
			const { fake } = setup()
			fake.command.role = 'admin'
			fake.failures.getCollaboratorRole.push(apiError())
			expect(
				yield* ThreadReplyService.use(service =>
					service.getCleared({
						waiting: ['thread'],
						resolvers: new Map([['thread', 'Contributor']]),
						allow: ['contributor'],
					})
				).pipe(
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
			).toEqual(new Set())
			expect(fake.reads).toEqual(['getCollaboratorRole:contributor'])
			expect(fake.writes).toEqual([])
		})
	)
})

layer(TOKEN_MODE_OWNED)('ThreadReplyService recovered owner state', test => {
	test.effect(
		'getSentToOwner returns open and resolved window hits and reads only overflowing non-nits',
		() =>
			Effect.gen(function* () {
				const { fake } = setup()
				const nit = reviewThread({ finding: bug(), kind: 'nit' }, { id: 'nit' })
				const unverified = reviewThread(
					{ finding: bug(), kind: 'unverified' },
					{ id: 'long-unverified' }
				)
				const threads = [
					ownerReviewThread(5, { id: 'open' }),
					ownerReviewThread(1, { id: 'resolved', isResolved: true }),
					rawThread('boundary', RECENT_COMMENTS),
					{ ...nit, comments: { ...nit.comments, totalCount: 20 } },
					rawThread('long-bug', RECENT_COMMENTS + 1),
					{
						...unverified,
						isResolved: true,
						comments: { ...unverified.comments, totalCount: 20 },
					},
					rawThread('long-without-answer', RECENT_COMMENTS + 1),
				]
				for (const id of ['long-bug', 'long-unverified'])
					fake.threadComments.set(id, [markedThreadReply()])
				fake.threadComments.set('long-without-answer', [threadReply()])
				expect(
					yield* ThreadReplyService.use(service =>
						service.getSentToOwner(threads)
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toEqual(['open', 'resolved', 'long-bug', 'long-unverified'])
				expect(fake.reads).toEqual([
					'listThreadComments:long-bug',
					'listThreadComments:long-unverified',
					'listThreadComments:long-without-answer',
				])
				expect(fake.writes).toEqual([])
			})
	)
	test.effect('a failed whole-thread recovery fails getSentToOwner', () =>
		Effect.gen(function* () {
			const { fake } = setup()
			const failure = apiError()
			fake.failures.listThreadComments.push(failure)
			expect(
				yield* ThreadReplyService.use(service =>
					service.getSentToOwner([
						ownerReviewThread(),
						rawThread('long', RECENT_COMMENTS + 1),
					])
				).pipe(
					Effect.flip,
					Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
				)
			).toEqual(failure)
			expect(fake.writes).toEqual([])
		})
	)
	for (const operation of ['collect', 'apply'] as const)
		test.effect(
			`${operation} skips sentToOwner before any read or write even without a waiting marker`,
			() =>
				Effect.gen(function* () {
					const { fake } = setup()
					const service = yield* ThreadReplyService.pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
					const threads = [pendingBotThread({ sentToOwner: true })]
					expect(
						yield* operation === 'collect'
							? service.collect({
									pullNumber: 17,
									threads,
									rotation: 0,
									waiting: [],
								})
							: service.apply({
									...replyRules(),
									links: LINKS,
									threads,
									waiting: [],
									decisions: [decidedReply()],
								})
					).toEqual([])
					expect(fake.reads).toEqual([])
					expect(fake.writes).toEqual([])
				})
		)
	for (const [role, allowed, fails, clears] of [
		['admin', false, false, true],
		['write', true, false, true],
		['write', false, false, false],
		['admin', true, true, false],
	] as const)
		test.effect(
			`edited root clears from raw resolver with role=${role}, allowed=${allowed}, failed=${fails}`,
			() =>
				Effect.gen(function* () {
					const { fake } = setup()
					fake.command.role = role
					if (fails) fake.failures.getCollaboratorRole.push(apiError())
					const root = reviewThread()
					const raw = reviewThread(undefined, {
						isResolved: true,
						resolvedBy: { login: 'Contributor' },
						comments: {
							...root.comments,
							nodes: root.comments.nodes.map(comment => ({
								...comment,
								editor: { __typename: 'User', login: 'editor' },
							})),
						},
					})
					expect(toBotThread(raw, [GITHUB_ACTIONS_IDENTITY])).toBeUndefined()
					expect(
						yield* ThreadReplyService.use(service =>
							service.getCleared({
								waiting: ['thread'],
								resolvers: toResolvers([raw]),
								allow: allowed ? ['CONTRIBUTOR'] : [],
							})
						).pipe(
							Effect.provide(
								ThreadReplyServiceLive.pipe(Layer.provide(fake.api))
							)
						)
					).toEqual(new Set(clears ? ['thread'] : []))
					expect(fake.reads).toEqual(['getCollaboratorRole:contributor'])
					expect(fake.writes).toEqual([])
				})
		)
})

layer(TOKEN_MODE_OWNED)(
	'ThreadReplyService owner decision validation',
	test => {
		for (const limit of [
			'critical',
			'risk-path',
			'renamed-risk-path',
			'severity',
		] as const)
			test.effect(
				`accepts needs-owner from the thread marker at the ${limit} limit without reading rounds`,
				() =>
					Effect.gen(function* () {
						const { fake } = setup()
						const cfg = config({
							disputes: {
								accept_intentional_up_to:
									limit === 'severity' ? 'medium' : 'critical',
							},
							risk_paths:
								limit === 'risk-path'
									? ['src/**']
									: limit === 'renamed-risk-path'
										? ['src/risk/**']
										: [],
						})
						const thread = pendingBotThread({
							marker: {
								...botThread().marker,
								severity:
									limit === 'critical'
										? 'critical'
										: limit === 'severity'
											? 'high'
											: 'low',
							},
						})
						expect(
							yield* ThreadReplyService.use(service =>
								service.apply({
									...replyRules(),
									config: cfg,
									change: {
										files:
											limit === 'renamed-risk-path'
												? [
														file(thread.path, {
															status: 'renamed',
															oldPath: 'src/risk/store.ts',
														}),
													]
												: [],
									},
									links: LINKS,
									waiting: [],
									threads: [thread],
									decisions: [
										decidedReply({
											action: 'needs-owner',
											reason: 'Owner required.',
										}),
									],
								})
							).pipe(
								Effect.provide(
									ThreadReplyServiceLive.pipe(Layer.provide(fake.api))
								)
							)
						).toHaveLength(1)
						// The one thread read is the check right before the answer, not the rounds.
						expect(fake.reads).toEqual([
							'getCollaboratorRole:contributor',
							'listThreadComments:thread',
						])
						expect(fake.writes.map(write => write.method)).toEqual(['reply'])
					})
			)
		for (const rounds of [
			'first-reply',
			'below-rounds',
			'at-rounds',
			'above-rounds',
			'pasted',
			'edited',
			'failed-read',
		] as const)
			test.effect(
				`needs-owner below the intentional limit validates ${rounds} against owned disputed answers`,
				() =>
					Effect.gen(function* () {
						const { fake } = setup()
						const maxRounds = 2
						const disputed = markedThreadReply('disputed')
						const count =
							rounds === 'first-reply'
								? 0
								: rounds === 'above-rounds'
									? 3
									: rounds === 'below-rounds'
										? 1
										: maxRounds
						fake.threadComments.set('thread', [
							...Array.from({ length: count }, (_, index) => ({
								...disputed,
								databaseId: index + 3,
								...(rounds === 'pasted'
									? { author: { __typename: 'User', login: 'contributor' } }
									: {}),
								...(rounds === 'edited'
									? { editor: { __typename: 'User', login: 'editor' } }
									: {}),
							})),
							threadReply({
								databaseId: 42,
								body: pendingReply().body,
								author: { __typename: 'User', login: 'contributor' },
							}),
						])
						if (rounds === 'failed-read')
							fake.failures.listThreadComments.push(apiError())
						const accepted = rounds === 'at-rounds' || rounds === 'above-rounds'
						expect(
							yield* ThreadReplyService.use(service =>
								service.apply({
									...replyRules(),
									config: config({
										disputes: {
											max_rounds: maxRounds,
											accept_intentional_up_to: 'high',
										},
									}),
									links: LINKS,
									waiting: [],
									threads: [pendingBotThread()],
									decisions: [
										decidedReply({
											action: 'needs-owner',
											reason: 'Disputed again.',
										}),
									],
								})
							).pipe(
								Effect.provide(
									ThreadReplyServiceLive.pipe(Layer.provide(fake.api))
								)
							)
						).toHaveLength(accepted ? 1 : 0)
						// The rounds read, then the check right before an answer that stands.
						expect(fake.reads).toEqual([
							'getCollaboratorRole:contributor',
							'listThreadComments:thread',
							...(accepted ? ['listThreadComments:thread'] : []),
						])
						expect(fake.writes.map(write => write.method)).toEqual(
							accepted ? ['reply'] : []
						)
					})
			)
		for (const decision of DECISIONS.filter(
			entry => entry.action !== 'needs-owner'
		))
			test.effect(
				`${decision.action} never reads rounds, only the thread right before its answer`,
				() =>
					Effect.gen(function* () {
						const { fake } = setup()
						expect(
							yield* ThreadReplyService.use(service =>
								service.apply({
									...replyRules(),
									config: ACCEPTING_RULES.config,
									links: LINKS,
									waiting: [],
									threads: [pendingBotThread()],
									decisions: [decidedReply(decision)],
								})
							).pipe(
								Effect.provide(
									ThreadReplyServiceLive.pipe(Layer.provide(fake.api))
								)
							)
						).toHaveLength(1)
						expect(fake.reads).toEqual([
							'getCollaboratorRole:contributor',
							'listThreadComments:thread',
						])
					})
			)
	}
)

layer(TOKEN_MODE_OWNED)('ThreadReplyService edited root recovery', test => {
	test.effect(
		'reads a long edited bot root whole to recover a needs-owner answer outside the latest comments, never a human root',
		() =>
			Effect.gen(function* () {
				const fake = githubApiFake()
				const edited = editedOwnerReviewThread(RECENT_COMMENTS, {
					id: 'edited',
				})
				const human = {
					...edited,
					id: 'human',
					comments: {
						...edited.comments,
						nodes: edited.comments.nodes.map(comment => ({
							...comment,
							author: { __typename: 'User', login: 'contributor' },
						})),
					},
				}
				for (const id of ['edited', 'human'])
					fake.threadComments.set(id, [
						markedThreadReply(),
						...(edited.latest?.nodes ?? []),
					])
				expect(
					yield* ThreadReplyService.use(service =>
						service.getSentToOwner([edited, human])
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toEqual(['edited'])
				expect(fake.reads).toEqual(['listThreadComments:edited'])
				expect(fake.writes).toEqual([])
			})
	)
})
