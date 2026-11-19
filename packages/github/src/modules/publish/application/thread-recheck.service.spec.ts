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
	LINKS,
	RULES,
} from '../../../shared/mocks/publish-test.helper'
import { escapeMarkdown } from '../../../utils/markdown.util'
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
			test.effect(`a failed ${failureAt} is not reported as a resolution`, () =>
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
					).toMatchObject({ checked: 1, resolved: [] })
					expect(fixture.api.writes.map(write => write.method)).toEqual(
						failureAt === 'reply' ? ['reply'] : ['reply', 'resolve']
					)
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
