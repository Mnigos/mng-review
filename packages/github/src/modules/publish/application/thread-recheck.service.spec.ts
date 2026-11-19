import { layer } from '@effect/vitest'
import type { Validation } from '@mng-review/domain'
import { RecheckService, type RecheckRequest } from '@mng-review/engine'
import { Effect, Layer } from 'effect'
import { GitHubApiError } from '../../../platform/github.errors'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { HOSTILE_TEXT } from '../../../shared/mocks/hostile-text.helper'
import {
	botThread,
	reviewThread,
	LINKS,
	RULES,
} from '../../../shared/mocks/publish-test.helper'
import { escapeMarkdown } from '../../../utils/markdown.util'
import { toBotThread } from '../domain/bot-thread.helper'
import { parseReplyMarker } from '../domain/publish-marker.parser'
import {
	MAX_RECHECKS,
	SHORT_SHA_LENGTH,
	MARKER_VERSION,
} from '../domain/publish.constants'
import { formatResolvedReply } from '../presentation/thread-comment.formatter'
import {
	ThreadRecheckService,
	ThreadRecheckServiceLive,
} from './thread-recheck.service'

const TOKENS = {
	validator: {
		calls: 1,
		inputTokens: 5,
		outputTokens: 2,
		cachedInputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 7,
	},
} as const

/** Valid tagged answers exercise each thread disposition without coercion. */
function toValidation(status: Validation['status']): Validation {
	const details = { reason: HOSTILE_TEXT, model: 'validator', evidence: [] }
	if (status === 'unvalidated') return { status, error: 'No verdict.' }
	if (status === 'unverified')
		return {
			...details,
			status,
			severity: 'high',
			premise: 'external contract',
		}
	return { ...details, status, severity: 'high' }
}

/** Real git differentiates unchanged paths, changed paths and unreadable commits. */
function setup(validation: Validation['status'] = 'rejected') {
	const repo = createRepo()
	repo.write('src/store.ts', 'before\n')
	repo.write('src/unchanged.ts', 'same\n')
	const base = repo.commit()
	repo.write('src/store.ts', 'after\n')
	const head = repo.commit()
	const api = githubApiFake()
	api.threads.push(reviewThread())
	const recheckSpy = vi.fn((request: RecheckRequest) =>
		Effect.succeed({
			results: request.items.map(item => ({
				...item,
				validation: toValidation(validation),
			})),
			tokens: TOKENS,
		})
	)
	const service = ThreadRecheckServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				api.api,
				gitLayer(repo.root),
				Layer.succeed(RecheckService, { recheck: recheckSpy })
			)
		)
	)
	const input = {
		pullNumber: 17,
		rotation: 0,
		pr: { labels: [], draft: false, fork: false, trigger: 'auto' as const },
		rules: RULES,
		links: { ...LINKS, head },
		published: [],
		threads: [botThread({ commit: base })],
	}
	return { repo, base, head, api, recheckSpy, service, input }
}

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })(
	'ThreadRecheckService',
	test => {
		test.effect(
			'checks only changed files with a readable diff, up to MAX_RECHECKS',
			() =>
				Effect.gen(function* () {
					const fixture = setup('confirmed')
					const changed = Array.from({ length: MAX_RECHECKS + 2 }, (_, index) =>
						botThread({ id: `changed-${index}`, commit: fixture.base })
					)
					const threads = [
						botThread({
							id: 'unchanged',
							path: 'src/unchanged.ts',
							commit: fixture.base,
						}),
						botThread({ id: 'unknown', commit: 'missing-commit' }),
						...changed,
					]
					expect(
						yield* ThreadRecheckService.use(service =>
							service.recheck({ ...fixture.input, threads })
						).pipe(Effect.provide(fixture.service))
					).toEqual({ checked: MAX_RECHECKS, resolved: [], tokens: TOKENS })
					const request = fixture.recheckSpy.mock.calls[0]?.[0]
					expect(request).toMatchObject({
						rules: RULES,
						pr: fixture.input.pr,
						headRef: fixture.head,
					})
					expect(request?.items).toHaveLength(MAX_RECHECKS)
					expect(
						request?.items.every(
							item =>
								item.base === fixture.base &&
								item.finding.path === 'src/store.ts'
						)
					).toBe(true)
					expect(fixture.api.writes).toEqual([])
				})
		)
		test.effect(
			'a rejected thread is replied to before it is resolved, with an escaped reason and decodable marker',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const result = yield* ThreadRecheckService.use(service =>
						service.recheck(fixture.input)
					).pipe(Effect.provide(fixture.service))
					expect(result).toEqual({
						checked: 1,
						resolved: [
							{ thread: fixture.input.threads[0], reason: HOSTILE_TEXT },
						],
						tokens: TOKENS,
					})
					const body = formatResolvedReply(HOSTILE_TEXT, fixture.input.links)
					expect(fixture.api.writes).toEqual([
						{ method: 'reply', id: 'thread', body },
						{ method: 'resolve', id: 'thread' },
					])
					expect(body).toContain(
						`at \`${fixture.head.slice(0, SHORT_SHA_LENGTH)}\``
					)
					expect(body).toContain(escapeMarkdown(HOSTILE_TEXT))
					expect(parseReplyMarker(body)).toEqual({
						v: MARKER_VERSION,
						action: 'resolved',
						commit: fixture.head,
					})
				})
		)
		for (const status of ['confirmed', 'unverified', 'unvalidated'] as const)
			test.effect(`${status} leaves the thread open`, () =>
				Effect.gen(function* () {
					const fixture = setup(status)
					expect(
						yield* ThreadRecheckService.use(service =>
							service.recheck(fixture.input)
						).pipe(Effect.provide(fixture.service))
					).toEqual({ checked: 1, resolved: [], tokens: TOKENS })
					expect(fixture.api.writes).toEqual([])
				})
			)
		for (const failureAt of ['reply', 'resolve'] as const)
			test.effect(
				`a failed ${failureAt} counts a resolution only when the reply was posted`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.api.failures[failureAt].push(
							new GitHubApiError({
								operation: failureAt,
								reason: 'denied',
								status: 403,
							})
						)
						expect(
							yield* ThreadRecheckService.use(service =>
								service.recheck(fixture.input)
							).pipe(Effect.provide(fixture.service))
						).toEqual({
							checked: 1,
							resolved:
								failureAt === 'reply'
									? []
									: [
											{
												thread: fixture.input.threads[0],
												reason: HOSTILE_TEXT,
											},
										],
							tokens: TOKENS,
						})
						expect(fixture.api.writes.map(write => write.method)).toEqual(
							failureAt === 'reply' ? ['reply'] : ['reply', 'resolve']
						)
						expect(fixture.api.threads[0]?.isResolved).toBe(false)
						expect(fixture.api.threads.map(toBotThread)).toMatchObject([
							{
								resolved: failureAt === 'resolve',
								closedByBot: failureAt === 'resolve',
							},
						])
					})
			)
		test.effect(
			'no changed candidates means no validator and no token replacement',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					expect(
						yield* ThreadRecheckService.use(service =>
							service.recheck({
								...fixture.input,
								threads: [
									botThread({ path: 'src/unchanged.ts', commit: fixture.base }),
								],
							})
						).pipe(Effect.provide(fixture.service))
					).toEqual({ checked: 0, resolved: [], tokens: undefined })
					expect(fixture.recheckSpy).not.toHaveBeenCalled()
				})
		)
	}
)

layer(Layer.empty, { excludeTestServices: true })(
	'ThreadRecheckService fresh state and rotation',
	test => {
		for (const change of [
			'reply',
			'resolved',
			'gone',
			'edited',
			'foreign',
			'read-failed',
		] as const)
			test.effect(
				`a rejected thread with ${change} at the second read is left alone`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.recheckSpy.mockImplementationOnce(request =>
							Effect.sync(() => {
								const [thread] = fixture.api.threads
								if (!thread) return { results: [], tokens: TOKENS }
								if (change === 'gone') fixture.api.threads.splice(0)
								else if (change === 'read-failed')
									fixture.api.failures.listThreads.push(
										new GitHubApiError({
											operation: 'threads',
											reason: 'denied',
											status: 403,
										})
									)
								else
									fixture.api.threads[0] = {
										...thread,
										isResolved: change === 'resolved',
										comments: {
											...thread.comments,
											totalCount: change === 'reply' ? 2 : 1,
											nodes: thread.comments.nodes.map(comment => ({
												...comment,
												...(change === 'edited'
													? {
															editor: {
																__typename: 'User',
																login: 'contributor',
															},
														}
													: {}),
												...(change === 'foreign'
													? {
															author: {
																__typename: 'User',
																login: 'contributor',
															},
														}
													: {}),
											})),
										},
									}
								return {
									results: request.items.map(item => ({
										...item,
										validation: toValidation('rejected'),
									})),
									tokens: TOKENS,
								}
							})
						)
						expect(
							yield* ThreadRecheckService.use(service =>
								service.recheck(fixture.input)
							).pipe(Effect.provide(fixture.service))
						).toEqual({ checked: 1, resolved: [], tokens: TOKENS })
						expect(fixture.recheckSpy).toHaveBeenCalledOnce()
						expect(fixture.api.threadReads).toEqual([17])
						expect(fixture.api.writes).toEqual([])
					})
			)
		test.effect('a later run rotates the capped validator batch', () =>
			Effect.gen(function* () {
				const fixture = setup('confirmed')
				const threads = Array.from({ length: MAX_RECHECKS + 2 }, (_, index) =>
					botThread({
						id: `changed-${index}`,
						commit: fixture.base,
						marker: { ...botThread().marker, title: `Problem ${index}` },
					})
				)
				const service = yield* ThreadRecheckService.pipe(
					Effect.provide(fixture.service)
				)
				yield* service.recheck({ ...fixture.input, threads, rotation: 0 })
				yield* service.recheck({ ...fixture.input, threads, rotation: 1 })
				expect(
					fixture.recheckSpy.mock.calls.map(([request]) =>
						request.items.map(item => item.finding.title)
					)
				).toEqual([
					threads.slice(0, MAX_RECHECKS).map(thread => thread.marker.title),
					[
						...threads.slice(MAX_RECHECKS),
						...threads.slice(0, MAX_RECHECKS - 2),
					].map(thread => thread.marker.title),
				])
				expect(fixture.api.threadReads).toEqual([])
				expect(fixture.api.writes).toEqual([])
			})
		)
	}
)
