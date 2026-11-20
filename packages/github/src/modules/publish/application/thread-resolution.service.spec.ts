import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_IDENTITIES,
	botThread,
	LINKS,
	reviewThread,
} from '../../../shared/mocks/publish-test.helper'
import { toBotThread } from '../domain/bot-thread.helper'
import { parseReplyMarker } from '../domain/publish-marker.parser'
import type { BotThread } from '../domain/publish.types'
import {
	ThreadResolutionService,
	ThreadResolutionServiceLive,
} from './thread-resolution.service'

/** Fresh publisher-owned threads and a recording GitHub layer. */
function setup(overrides: Partial<BotThread> = {}) {
	const fake = githubApiFake()
	const thread = botThread({ commit: 'earlier-commit', ...overrides })
	const service = ThreadResolutionServiceLive.pipe(Layer.provide(fake.api))
	const proposal = {
		threadId: thread.id,
		fingerprint: thread.marker.fingerprint,
		reason: 'The write is guarded.',
	}
	const input = { links: LINKS, proposals: [proposal], threads: [thread] }
	return { fake, thread, service, proposal, input }
}

layer(Layer.empty)('ThreadResolutionService', test => {
	for (const scenario of [
		'unknown-id',
		'fingerprint',
		'resolved',
		'reply',
		'nit',
		'head',
		'missing-commit',
	] as const)
		test.effect(`writes nothing for ${scenario}`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				const { thread } = fixture
				const changed =
					scenario === 'resolved'
						? { ...thread, resolved: true }
						: scenario === 'reply'
							? { ...thread, replies: 1 }
							: scenario === 'nit'
								? {
										...thread,
										marker: { ...thread.marker, kind: 'nit' as const },
									}
								: scenario === 'head'
									? { ...thread, commit: LINKS.head }
									: scenario === 'missing-commit'
										? { ...thread, commit: undefined }
										: thread
				const proposals =
					scenario === 'unknown-id'
						? [{ ...fixture.proposal, threadId: 'unknown' }]
						: scenario === 'fingerprint'
							? [{ ...fixture.proposal, fingerprint: 'different' }]
							: [fixture.proposal]
				expect(
					yield* ThreadResolutionService.use(service =>
						service.apply({ ...fixture.input, proposals, threads: [changed] })
					).pipe(Effect.provide(fixture.service))
				).toEqual([])
				expect(fixture.fake.writes).toEqual([])
				expect(fixture.fake.threadReads).toEqual([])
			})
		)
	for (const kind of ['bug', 'unverified'] as const)
		test.effect(`replies once and tries to resolve an eligible ${kind}`, () =>
			Effect.gen(function* () {
				const fixture = setup({ marker: { ...botThread().marker, kind } })
				expect(
					yield* ThreadResolutionService.use(service =>
						service.apply(fixture.input)
					).pipe(Effect.provide(fixture.service))
				).toEqual([{ thread: fixture.thread, reason: fixture.proposal.reason }])
				expect(
					fixture.fake.writes.map(write => ({
						method: write.method,
						id: 'id' in write ? write.id : undefined,
					}))
				).toEqual([
					{ method: 'reply', id: fixture.thread.id },
					{ method: 'resolve', id: fixture.thread.id },
				])
				const [reply] = fixture.fake.writes
				if (reply?.method === 'reply')
					expect(reply.body).toContain(fixture.proposal.reason)
				expect(fixture.fake.threadReads).toEqual([])
			})
		)
	test.effect('deduplicates a repeated proposal before writing', () =>
		Effect.gen(function* () {
			const fixture = setup()
			expect(
				yield* ThreadResolutionService.use(service =>
					service.apply({
						...fixture.input,
						proposals: [fixture.proposal, fixture.proposal],
					})
				).pipe(Effect.provide(fixture.service))
			).toHaveLength(1)
			expect(fixture.fake.writes.map(write => write.method)).toEqual([
				'reply',
				'resolve',
			])
		})
	)
	test.effect('a failed reply is not resolved or returned', () =>
		Effect.gen(function* () {
			const fixture = setup()
			fixture.fake.failures.reply.push(
				new GitHubApiError({
					operation: 'reply',
					reason: 'Forbidden.',
					status: 403,
				})
			)
			expect(
				yield* ThreadResolutionService.use(service =>
					service.apply(fixture.input)
				).pipe(Effect.provide(fixture.service))
			).toEqual([])
			expect(fixture.fake.writes.map(write => write.method)).toEqual(['reply'])
		})
	)
	test.effect('a failed resolve still counts a successful closing reply', () =>
		Effect.gen(function* () {
			const fixture = setup()
			fixture.fake.failures.resolve.push(
				new GitHubApiError({
					operation: 'resolve',
					reason: 'Forbidden.',
					status: 403,
				})
			)
			expect(
				yield* ThreadResolutionService.use(service =>
					service.apply(fixture.input)
				).pipe(Effect.provide(fixture.service))
			).toEqual([{ thread: fixture.thread, reason: fixture.proposal.reason }])
			expect(fixture.fake.writes.map(write => write.method)).toEqual([
				'reply',
				'resolve',
			])
		})
	)
	test.effect('escapes a mention, URL and HTML in the reason', () =>
		Effect.gen(function* () {
			const fixture = setup()
			yield* ThreadResolutionService.use(service =>
				service.apply({
					...fixture.input,
					proposals: [
						{
							...fixture.proposal,
							reason: '@contributor https://example.com/fix <img src=x>',
						},
					],
				})
			).pipe(Effect.provide(fixture.service))
			const [reply] = fixture.fake.writes
			expect(reply).toMatchObject({ method: 'reply' })
			if (reply?.method !== 'reply') return
			expect(reply.body).toContain(
				'`@contributor` `https://example.com/fix` \\<img src=x\\>'
			)
			expect(reply.body).not.toContain('<img src=x>')
			expect(parseReplyMarker(reply.body)).toMatchObject({
				action: 'resolved',
				commit: LINKS.head,
			})
		})
	)
})

layer(Layer.empty)('ThreadResolutionService app reply', test => {
	test.effect(
		'applies a proposal in a job-token thread and the app reply closes it',
		() =>
			Effect.gen(function* () {
				const fake = githubApiFake(APP_IDENTITY)
				const original = reviewThread()
				fake.threads.push(original)
				fake.failures.resolve.push(
					new GitHubApiError({
						operation: 'resolve',
						reason: 'forbidden',
						status: 403,
					})
				)
				const thread = toBotThread(original, APP_MODE_IDENTITIES)
				expect(thread).toBeDefined()
				if (!thread) return
				expect(
					yield* ThreadResolutionService.use(service =>
						service.apply({
							links: { ...LINKS, head: 'new-head' },
							threads: [thread],
							proposals: [
								{
									threadId: thread.id,
									fingerprint: thread.marker.fingerprint,
									reason: 'The write is guarded.',
								},
							],
						})
					).pipe(
						Effect.provide(
							ThreadResolutionServiceLive.pipe(Layer.provide(fake.api))
						)
					)
				).toHaveLength(1)
				expect(fake.writes.map(write => write.method)).toEqual([
					'reply',
					'resolve',
				])
				expect(fake.threads[0]?.latest?.nodes[0]?.author?.login).toBe(
					APP_IDENTITY.login
				)
				const [updated] = fake.threads
				expect(
					updated && toBotThread(updated, APP_MODE_IDENTITIES)
				).toMatchObject({ resolved: true, closedByBot: true })
			})
	)
})
