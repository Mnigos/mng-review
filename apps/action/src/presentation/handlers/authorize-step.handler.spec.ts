import { layer } from '@effect/vitest'
import { ConfigError } from '@mng-review/domain'
import { GitError, RulesService } from '@mng-review/engine'
import {
	CommandAuthorizeServiceLive,
	CommandAnswerServiceLive,
	AnswerReadService,
	GitHubApiError,
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

layer(FileSystemLayer)('authorize risk command answers', test => {
	for (const scenario of [
		'cap',
		'owner denial',
		'edited',
		'off',
		'job token',
	] as const)
		test.effect(
			`${scenario} writes only the authorized or answer outputs`,
			() =>
				Effect.gen(function* () {
					const appMode = scenario !== 'job token'
					const fixture = stepFixture([], appMode, true)
					fixture.api.command.role =
						scenario === 'owner denial' ? 'write' : 'admin'
					if (scenario === 'job token')
						fixture.api.command.comment = {
							...fixture.api.command.comment,
							body: '@github-actions review',
						}
					const action = scenario === 'edited' ? 'edited' : 'created'
					fixture.repo.write(
						'event.json',
						JSON.stringify({
							action,
							comment: fixture.api.command.comment,
							issue: { number: 17, pull_request: {} },
						})
					)
					const rules = {
						...fixture.rules,
						config: {
							...fixture.rules.config,
							risk: {
								...fixture.rules.config.risk,
								enabled: scenario !== 'off',
								reviews_per_head: 3,
							},
						},
					}
					const getCountedReviewsSpy = vi.fn(() =>
						Effect.succeed(
							[1, 2, 3, fixture.api.command.comment.id].map(id => ({
								id,
								at: '2026-01-01T12:00:00Z',
								body: '@mng-review review',
								review: true,
								actedOn: true,
							}))
						)
					)
					const answers = Layer.succeed(AnswerReadService, {
						getCountedReviews: getCountedReviewsSpy,
						readCommands: () => Effect.die('unused'),
						getCommandEntry: () => Effect.die('unused'),
					})
					yield* runAuthorizeStep.pipe(
						Effect.provide(
							CommandAnswerServiceLive.pipe(
								Layer.provideMerge(answers),
								Layer.provideMerge(fixture.publisherLayer)
							)
						),
						Effect.provide(
							CommandAuthorizeServiceLive.pipe(
								Layer.provide(fixture.publisherLayer)
							)
						),
						Effect.provide(
							Layer.succeed(RulesService, { load: () => Effect.succeed(rules) })
						),
						Effect.provide(
							fixture.envLayer({
								GITHUB_EVENT_NAME: 'issue_comment',
								...(appMode
									? { MNG_REVIEW_APP_SLUG: 'mng-review' }
									: { MNG_REVIEW_HANDLE: 'github-actions' }),
							})
						)
					)
					const output = yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.output
					)
					if (scenario === 'off' || scenario === 'job token') {
						expect(output).toContain('authorized=true')
						expect(output).not.toContain('answer=')
						expect(getCountedReviewsSpy).not.toHaveBeenCalled()
					} else {
						expect(output).toContain('authorized=false')
						expect(output).toContain(
							`answer=${scenario === 'cap' ? 'cap' : 'deny'}`
						)
						expect(output).toContain('answer_pull=17')
						expect(output).toContain(
							`answer_comment=${fixture.api.command.comment.id}`
						)
						if (scenario === 'edited')
							expect(output).toContain(
								'the comment changed; post a new command'
							)
					}
					expect(fixture.api.writes).toEqual([])
				})
		)
	test.effect(
		'a failed cap read fails the decide job and writes no decision',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture([], true, true)
				fixture.api.command.role = 'admin'
				fixture.repo.write(
					'event.json',
					JSON.stringify({
						action: 'created',
						comment: fixture.api.command.comment,
						issue: { number: 17, pull_request: {} },
					})
				)
				const rules = {
					...fixture.rules,
					config: {
						...fixture.rules.config,
						risk: { ...fixture.rules.config.risk, enabled: true },
					},
				}
				const answers = Layer.succeed(AnswerReadService, {
					getCountedReviews: () =>
						Effect.fail(
							new GitHubApiError({
								operation: 'timeline',
								status: 502,
								reason: 'unavailable',
							})
						),
					readCommands: () => Effect.die('unused'),
					getCommandEntry: () => Effect.die('unused'),
				})
				const error = yield* Effect.flip(
					runAuthorizeStep.pipe(
						Effect.provide(
							CommandAnswerServiceLive.pipe(
								Layer.provideMerge(answers),
								Layer.provideMerge(fixture.publisherLayer)
							)
						),
						Effect.provide(
							CommandAuthorizeServiceLive.pipe(
								Layer.provide(fixture.publisherLayer)
							)
						),
						Effect.provide(
							Layer.succeed(RulesService, { load: () => Effect.succeed(rules) })
						),
						Effect.provide(
							fixture.envLayer({
								GITHUB_EVENT_NAME: 'issue_comment',
								MNG_REVIEW_APP_SLUG: 'mng-review',
							})
						)
					)
				)
				expect(error).toMatchObject({ _tag: 'GitHubApiError', status: 502 })
				expect(
					yield* (yield* FileSystem.FileSystem).exists(fixture.paths.output)
				).toBeFalsy()
			})
	)
})
