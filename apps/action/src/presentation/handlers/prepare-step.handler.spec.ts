import { layer } from '@effect/vitest'
import {
	GitHubApiError,
	GitHubConfig,
	GitHubConfigLive,
} from '@mng-review/github'
import { ConfigProvider, Effect, FileSystem, Layer } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires these existing unexported GitHub fixtures.
import { reviewThread } from '../../../../../packages/github/src/shared/mocks/publish-test.helper'
import { PrepareRunServiceLive } from '../../application/prepare-run.service'
import { parsePreparedRun } from '../../infrastructure/prepared-run.parser'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { runPrepareStep } from './prepare-step.handler'

afterEach(() => {
	cleanupRepos()
})

layer(FileSystemLayer)('prepare step', test => {
	test.effect(
		'GitHub read errors still write ready without prior runs or threads',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const fs = yield* FileSystem.FileSystem
				const error = new GitHubApiError({
					operation: 'read',
					reason: 'unavailable',
					status: 503,
				})
				fixture.api.failures.listThreads.push(error)
				fixture.api.failures.listComments.push(error)
				yield* runPrepareStep.pipe(
					Effect.provide(
						PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer())
				)
				expect(
					yield* parsePreparedRun(
						yield* fs.readFileString(fixture.paths.prepared)
					)
				).toMatchObject({ status: 'ready', threads: [] })
				const text = yield* fs.readFileString(fixture.paths.prepared)
				expect(JSON.parse(text)).not.toHaveProperty('prior')
				expect(JSON.parse(text)).not.toHaveProperty('rules')
				expect(yield* fs.readFileString(fixture.paths.output)).toBe(
					'ready=true\n'
				)
				expect(fixture.api.writes).toEqual([])
			})
	)
	test.effect(
		'serializes only bot-owned unedited threads with valid markers',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const bot = reviewThread()
				fixture.api.threads.push(
					{ ...bot, id: 'owned' },
					{
						...bot,
						id: 'human',
						comments: {
							totalCount: 1,
							nodes: bot.comments.nodes.map(comment => ({
								...comment,
								author: { __typename: 'User', login: 'contributor' },
							})),
						},
					},
					{
						...bot,
						id: 'edited',
						comments: {
							totalCount: 1,
							nodes: bot.comments.nodes.map(comment => ({
								...comment,
								editor: { __typename: 'User', login: 'contributor' },
							})),
						},
					},
					{
						...bot,
						id: 'broken',
						comments: {
							totalCount: 1,
							nodes: bot.comments.nodes.map(comment => ({
								...comment,
								body: 'ordinary comment',
							})),
						},
					}
				)
				yield* runPrepareStep.pipe(
					Effect.provide(
						PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer())
				)
				const fs = yield* FileSystem.FileSystem
				const prepared = yield* parsePreparedRun(
					yield* fs.readFileString(fixture.paths.prepared)
				)
				expect(prepared.status).toBe('ready')
				if (prepared.status === 'ready')
					expect(prepared.threads.map(thread => thread.id)).toEqual(['owned'])
				expect(fixture.api.writes).toEqual([])
			})
	)
})

layer(Layer.empty)('prepare configuration', test => {
	for (const token of [undefined, '', '   '])
		test.effect(`requires GITHUB_TOKEN when ${JSON.stringify(token)}`, () =>
			Effect.gen(function* () {
				expect(
					yield* GitHubConfig.pipe(
						Effect.provide(GitHubConfigLive),
						Effect.provide(
							ConfigProvider.layer(
								ConfigProvider.fromEnvRecord({
									GITHUB_REPOSITORY: 'example/project',
									...(token === undefined ? {} : { GITHUB_TOKEN: token }),
								})
							)
						),
						Effect.flip
					)
				).toMatchObject({ _tag: 'ConfigError', source: 'GITHUB_TOKEN' })
			})
		)
})
