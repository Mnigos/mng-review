import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
	BASE_SHA,
	HEAD_SHA,
	eventPayload,
} from '../shared/mocks/pull-request-event.helper'
import {
	EVENT_PATH_VARIABLE,
	parsePullRequestEvent,
} from './pull-request-event.parser'

layer(Layer.empty)('parsePullRequestEvent', test => {
	test.effect('reads a trimmed target event and ignores unrelated fields', () =>
		Effect.gen(function* () {
			expect(
				yield* parsePullRequestEvent(JSON.stringify(eventPayload()))
			).toEqual({
				number: 17,
				baseSha: BASE_SHA,
				headSha: HEAD_SHA,
				pr: {
					title: 'Update item storage',
					body: 'Keep item writes consistent.',
					author: 'contributor',
					target: 'main',
					labels: ['storage'],
					draft: false,
					fork: false,
					trigger: 'auto',
				},
			})
		})
	)
	for (const repo of [{ full_name: 'example/fork' }, null])
		test.effect(
			`recognizes ${repo === null ? 'a deleted fork' : 'a different head repository'}`,
			() =>
				Effect.gen(function* () {
					const payload = eventPayload()
					const event = yield* parsePullRequestEvent(
						JSON.stringify({
							...payload,
							pull_request: {
								...payload.pull_request,
								head: { ...payload.pull_request.head, repo },
							},
						})
					)
					expect(event.pr.fork).toBe(true)
				})
		)
	test.effect('preserves draft and omits null body and deleted user', () =>
		Effect.gen(function* () {
			const payload = eventPayload()
			const event = yield* parsePullRequestEvent(
				JSON.stringify({
					...payload,
					pull_request: {
						...payload.pull_request,
						draft: true,
						body: null,
						user: null,
					},
				})
			)
			expect(event.pr.draft).toBe(true)
			expect(event.pr).not.toHaveProperty('body')
			expect(event.pr).not.toHaveProperty('author')
		})
	)
	test.effect('defaults an absent draft flag and accepts SHA-256 commits', () =>
		Effect.gen(function* () {
			const payload = eventPayload()
			const event = yield* parsePullRequestEvent(
				JSON.stringify({
					...payload,
					pull_request: {
						...payload.pull_request,
						draft: undefined,
						base: { ...payload.pull_request.base, sha: 'a'.repeat(64) },
					},
				})
			)
			expect(event.pr.draft).toBe(false)
			expect(event.baseSha).toBe('a'.repeat(64))
		})
	)
	for (const side of ['base', 'head'] as const)
		test.effect(`rejects a git option in the ${side} SHA`, () =>
			Effect.gen(function* () {
				const payload = eventPayload()
				expect(
					yield* parsePullRequestEvent(
						JSON.stringify({
							...payload,
							pull_request: {
								...payload.pull_request,
								[side]: {
									...payload.pull_request[side],
									sha: '--upload-pack=x',
								},
							},
						})
					).pipe(Effect.flip)
				).toMatchObject({ _tag: 'ConfigError', source: EVENT_PATH_VARIABLE })
			})
		)
	for (const text of ['{}', '{', JSON.stringify({ pull_request: null })])
		test.effect(`rejects an invalid or missing pull request: ${text}`, () =>
			Effect.gen(function* () {
				expect(
					yield* parsePullRequestEvent(text).pipe(Effect.flip)
				).toMatchObject({ _tag: 'ConfigError', source: EVENT_PATH_VARIABLE })
			})
		)
})
