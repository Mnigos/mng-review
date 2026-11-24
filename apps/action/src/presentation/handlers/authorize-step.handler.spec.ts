import { layer } from '@effect/vitest'
import { ConfigError } from '@mng-review/domain'
import { GitError, RulesService } from '@mng-review/engine'
import {
	CommandAuthorizeServiceLive,
	GitHubConfig,
	GitHubReadConfigLive,
} from '@mng-review/github'
import { Effect, FileSystem, Layer } from 'effect'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { CommandAnswerOffLayer } from '../../shared/mocks/risk-run.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { denyAuthorizeConfig, runAuthorizeStep } from './authorize-step.handler'

afterEach(() => {
	cleanupRepos()
})

layer(FileSystemLayer)('authorize step', test => {
	for (const depth of ['deep', 'quick'] as const)
		test.effect(
			`writes the authorized ${depth} request without losing its depth`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture([], true, true)
					fixture.api.command.comment = {
						...fixture.api.command.comment,
						body: `@mng-review review ${depth}`,
					}
					fixture.repo.write(
						'event.json',
						JSON.stringify({
							action: 'created',
							comment: fixture.api.command.comment,
							issue: { number: 17, pull_request: {} },
						})
					)
					yield* runAuthorizeStep.pipe(
						Effect.provide(
							CommandAuthorizeServiceLive.pipe(
								Layer.provideMerge(fixture.publisherLayer),
								Layer.merge(CommandAnswerOffLayer)
							)
						),
						Effect.provide(fixture.rulesLayer),
						Effect.provide(
							fixture.envLayer({
								GITHUB_EVENT_NAME: 'issue_comment',
								MNG_REVIEW_APP_SLUG: 'mng-review',
							})
						)
					)
					expect(
						yield* (yield* FileSystem.FileSystem).readFileString(
							fixture.paths.output
						)
					).toBe(
						`authorized=true\npull_number=17\nbase_sha=${fixture.api.command.pullRequest.base.sha}\nhead_sha=${fixture.api.command.pullRequest.head.sha}\ndepth=${depth}\nagent=\n`
					)
					expect(fixture.loads).toEqual(['HEAD'])
					expect(fixture.api.writes).toEqual([])
				})
		)

	for (const scenario of [
		'authorized',
		'denied',
		'invalid event',
		'git error',
		'rules error',
		'event read error',
	] as const)
		test.effect(`${scenario} writes a decision and passes the job`, () =>
			Effect.gen(function* () {
				const fixture = stepFixture([], true, true)
				const fs = yield* FileSystem.FileSystem
				fixture.repo.write(
					'event.json',
					scenario === 'invalid event'
						? '{'
						: JSON.stringify({
								action: 'created',
								comment: fixture.api.command.comment,
								issue: { number: 17, pull_request: {} },
							})
				)
				if (scenario === 'denied') fixture.api.command.role = 'read'
				const rulesLayer =
					scenario === 'git error' || scenario === 'rules error'
						? Layer.succeed(RulesService, {
								load: () =>
									Effect.fail(
										scenario === 'git error'
											? new GitError({
													args: ['show'],
													exitCode: 128,
													stderr: 'missing commit',
												})
											: new ConfigError({
													source: '.mng/review.yml',
													reason: 'invalid rules',
												})
									),
							})
						: fixture.rulesLayer
				yield* runAuthorizeStep.pipe(
					Effect.provide(
						CommandAuthorizeServiceLive.pipe(
							Layer.provideMerge(fixture.publisherLayer),
							Layer.merge(CommandAnswerOffLayer)
						)
					),
					Effect.provide(rulesLayer),
					Effect.catchTag('ConfigError', denyAuthorizeConfig),
					Effect.provide(
						fixture.envLayer({
							GITHUB_EVENT_NAME: 'issue_comment',
							MNG_REVIEW_APP_SLUG: 'mng-review',
							...(scenario === 'event read error'
								? { GITHUB_EVENT_PATH: `${fixture.repo.root}/missing.json` }
								: {}),
						})
					)
				)
				expect(yield* fs.readFileString(fixture.paths.output)).toBe(
					scenario === 'authorized'
						? `authorized=true\npull_number=17\nbase_sha=${fixture.api.command.pullRequest.base.sha}\nhead_sha=${fixture.api.command.pullRequest.head.sha}\ndepth=\nagent=\n`
						: 'authorized=false\n'
				)
				expect(yield* fs.readFileString(fixture.paths.summary)).toContain(
					scenario === 'authorized' ? 'command authorized' : 'command not run'
				)
				expect(fixture.loads).toEqual(
					['authorized', 'denied'].includes(scenario) ? ['HEAD'] : []
				)
				expect(fixture.api.writes).toEqual([])
			})
		)
	test.effect(
		'a read-token config failure denies with exit zero before GitHub',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				yield* GitHubConfig.pipe(
					Effect.provide(GitHubReadConfigLive),
					Effect.flatMap(() =>
						runAuthorizeStep.pipe(
							Effect.provide(
								CommandAuthorizeServiceLive.pipe(
									Layer.provideMerge(fixture.publisherLayer),
									Layer.merge(CommandAnswerOffLayer)
								)
							),
							Effect.provide(fixture.rulesLayer)
						)
					),
					Effect.catchTag('ConfigError', denyAuthorizeConfig),
					Effect.provide(fixture.envLayer({ GITHUB_TOKEN: '' }))
				)
				const fs = yield* FileSystem.FileSystem
				expect(yield* fs.readFileString(fixture.paths.output)).toBe(
					'authorized=false\n'
				)
				expect(yield* fs.readFileString(fixture.paths.summary)).toContain(
					'GITHUB\\_TOKEN'
				)
				expect(fixture.api.reads).toEqual([])
				expect(fixture.api.writes).toEqual([])
				expect(fixture.loads).toEqual([])
			})
	)
})
