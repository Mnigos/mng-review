import { layer } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { HOSTILE_TEXT } from '../../../shared/mocks/hostile-text.helper'
import {
	ACCEPTING_RULES,
	LINKS,
	TOKEN_MODE_OWNED,
	threadReply,
} from '../../../shared/mocks/publish-test.helper'
import {
	decidedReply,
	pendingBotThread,
	pendingReply,
	pendingReviewThread,
	replyRules,
} from '../../../shared/mocks/thread-reply-test.helper'
import { parseMentionCommand } from '../../command/domain/mention-command.parser'
import { toBodyDigest, toBotThread } from '../domain/bot-thread.helper'
import { parseReplyMarker } from '../domain/publish-marker.parser'
import {
	MARKER_VERSION,
	MAX_REPLY_CHARS,
	MAX_REPLY_THREADS,
	SHORT_SHA_LENGTH,
} from '../domain/publish.constants'
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
	{
		action: 'accepted',
		reason: 'The caller guards it.',
		memory: 'Keep the guard.',
		evidence: ['src/store.ts:10'],
	},
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
				})
				const next = yield* service.collect({
					pullNumber: 17,
					threads,
					rotation: 1,
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
						})
					).pipe(
						Effect.provide(ThreadReplyServiceLive.pipe(Layer.provide(fake.api)))
					)
				).toEqual([])
			})
	)
})

layer(TOKEN_MODE_OWNED)('ThreadReplyService apply', test => {
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
				})
				expect(replies).toEqual([pendingReply()])
				fake.command.role = 'read'
				expect(
					yield* service.apply({
						...replyRules(),
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
				fake.failures.getCollaboratorRole.push(apiError())
				const answered = yield* ThreadReplyService.use(service =>
					service.apply({
						...replyRules(),
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
				expect(fake.reads).toEqual([
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
				expect(
					yield* ThreadReplyService.use(service =>
						service.apply({
							...replyRules(),
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
				expect(fake.reads).toEqual(['getCollaboratorRole:contributor'])
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
	for (const decision of DECISIONS)
		test.effect(
			`${decision.action} writes its text and the answered comment marker`,
			() =>
				Effect.gen(function* () {
					const { fake } = setup()
					const answered = yield* ThreadReplyService.use(service =>
						service.apply({
							...replyRules(),
							config: ACCEPTING_RULES.config,
							links: LINKS,
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
	for (const invalid of ['stale', 'fingerprint', 'unknown', 'foreign'] as const)
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
