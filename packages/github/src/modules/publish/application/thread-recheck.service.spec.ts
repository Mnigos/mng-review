import { layer } from '@effect/vitest'
import type { Validation } from '@mng-review/domain'
import { RecheckService, type RecheckRequest } from '@mng-review/engine'
import { Effect, Layer } from 'effect'
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
	RULES,
} from '../../../shared/mocks/publish-test.helper'
import { MAX_RECHECKS } from '../domain/publish.constants'
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
				gitLayer(repo.root),
				Layer.succeed(RecheckService, { recheck: recheckSpy })
			)
		)
	)
	const input = {
		rotation: 0,
		pr: { labels: [], draft: false, fork: false, trigger: 'auto' as const },
		rules: RULES,
		head,
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
							service.propose({ ...fixture.input, threads })
						).pipe(Effect.provide(fixture.service))
					).toEqual({ checked: MAX_RECHECKS, rejected: [], tokens: TOKENS })
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
		test.effect('a rejected thread is proposed and nothing is written', () =>
			Effect.gen(function* () {
				const fixture = setup()
				expect(
					yield* ThreadRecheckService.use(service =>
						service.propose(fixture.input)
					).pipe(Effect.provide(fixture.service))
				).toEqual({
					checked: 1,
					rejected: [
						{ thread: fixture.input.threads[0], reason: HOSTILE_TEXT },
					],
					tokens: TOKENS,
				})
				expect(fixture.api.threadReads).toEqual([])
				expect(fixture.api.writes).toEqual([])
			})
		)
		for (const status of ['confirmed', 'unverified', 'unvalidated'] as const)
			test.effect(`${status} leaves the thread open`, () =>
				Effect.gen(function* () {
					const fixture = setup(status)
					expect(
						yield* ThreadRecheckService.use(service =>
							service.propose(fixture.input)
						).pipe(Effect.provide(fixture.service))
					).toEqual({ checked: 1, rejected: [], tokens: TOKENS })
					expect(fixture.api.writes).toEqual([])
				})
			)
		test.effect(
			'no changed candidates means no validator and no token replacement',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					expect(
						yield* ThreadRecheckService.use(service =>
							service.propose({
								...fixture.input,
								threads: [
									botThread({ path: 'src/unchanged.ts', commit: fixture.base }),
								],
							})
						).pipe(Effect.provide(fixture.service))
					).toEqual({ checked: 0, rejected: [], tokens: undefined })
					expect(fixture.recheckSpy).not.toHaveBeenCalled()
				})
		)
	}
)

layer(Layer.empty, { excludeTestServices: true })(
	'ThreadRecheckService rotation',
	test => {
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
				yield* service.propose({ ...fixture.input, threads, rotation: 0 })
				yield* service.propose({ ...fixture.input, threads, rotation: 1 })
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

layer(Layer.empty, { excludeTestServices: true })(
	'ThreadRecheckService failures',
	test => {
		test.effect(
			'a validator with no results proposes nothing without a GitHub layer',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.recheckSpy.mockImplementation(() =>
						Effect.succeed({ results: [], tokens: TOKENS })
					)
					expect(
						yield* ThreadRecheckService.use(service =>
							service.propose(fixture.input)
						).pipe(Effect.provide(fixture.service))
					).toEqual({ checked: 1, rejected: [], tokens: TOKENS })
					expect(fixture.api.threadReads).toEqual([])
					expect(fixture.api.writes).toEqual([])
				})
		)
	}
)
