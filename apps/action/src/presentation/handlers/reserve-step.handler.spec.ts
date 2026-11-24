import { layer } from '@effect/vitest'
import { RulesService } from '@mng-review/engine'
import {
	GitHubApiError,
	GitHubConfig,
	GitHubWriteConfigLive,
	ListCompleteness,
	SummaryReviewService,
} from '@mng-review/github'
import { Effect, FileSystem, Layer } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The summary's count is asserted at the real marker boundary.
import { parseSummaryMarker } from '../../../../../packages/github/src/modules/publish/domain/publish-marker.parser'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires the existing recording GitHub fake fixtures.
import {
	appSummary,
	SUMMARY_MARKER,
} from '../../../../../packages/github/src/shared/mocks/publish-test.helper'
import { PrepareRunServiceLive } from '../../application/prepare-run.service'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { failReserveConfig, runReserveStep } from './reserve-step.handler'

afterEach(() => {
	cleanupRepos()
})

layer(FileSystemLayer)('reserve step', test => {
	for (const scenario of [
		'reserved',
		'cap',
		'draft',
		'closed',
		'moved',
		'fork',
		'missing agent',
		'skip label',
		'GitHub read error',
		'GitHub count error',
	] as const)
		test.effect(
			`${scenario} counts only a runnable command and exits zero`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture([], true)
					const pr = fixture.api.command.pullRequest
					fixture.api.command.pullRequest = {
						...pr,
						draft: scenario === 'draft',
						state: scenario === 'closed' ? 'closed' : 'open',
						base: { ...pr.base, sha: fixture.base },
						head: {
							sha: scenario === 'moved' ? 'c'.repeat(40) : fixture.head,
							repo: {
								full_name:
									scenario === 'fork' ? 'example/fork' : pr.base.repo.full_name,
							},
						},
						labels: scenario === 'skip label' ? [{ name: 'no-review' }] : [],
					}
					const rules = {
						...fixture.rules,
						config: {
							...fixture.rules.config,
							skip: { ...fixture.rules.config.skip, labels: ['no-review'] },
							commands: { ...fixture.rules.config.commands, max_runs: 1 },
						},
					}
					if (scenario === 'cap')
						fixture.api.comments.push(
							appSummary({ ...SUMMARY_MARKER, manualRuns: 1 })
						)
					if (
						scenario === 'GitHub read error' ||
						scenario === 'GitHub count error'
					) {
						const error = new GitHubApiError({
							operation: 'read',
							status: 503,
							reason: 'unavailable',
						})
						if (scenario === 'GitHub read error')
							fixture.api.failures.getPullRequest.push(error)
						else fixture.api.failures.listComments.push(error)
					}
					yield* runReserveStep.pipe(
						Effect.provide(
							PrepareRunServiceLive.pipe(
								Layer.provide(
									Layer.succeed(RulesService, {
										load: source => {
											expect(source).toBe(fixture.base)
											return Effect.succeed(rules)
										},
									})
								)
							)
						),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(
							fixture.envLayer({
								MNG_REVIEW_APP_SLUG: 'mng-review',
								MNG_REVIEW_TARGET_PR: '17',
								MNG_REVIEW_TARGET_BASE: fixture.base,
								MNG_REVIEW_TARGET_HEAD: fixture.head,
								...(scenario === 'missing agent'
									? { MNG_REVIEW_COMMAND_AGENT: 'missing' }
									: {}),
							})
						)
					)
					const fs = yield* FileSystem.FileSystem
					expect(yield* fs.readFileString(fixture.paths.output)).toBe(
						`reserved=${scenario === 'reserved'}\n`
					)
					expect(fixture.api.reads).toEqual(['getPullRequest:17'])
					if (scenario === 'reserved') {
						expect(fixture.api.writes).toHaveLength(1)
						expect(
							parseSummaryMarker(
								fixture.api.reviews.at(-1)?.body ??
									fixture.api.comments[0]?.body ??
									''
							)
						).toMatchObject({ manualRuns: 1, runs: 0, finished: false })
						expect(yield* fs.exists(fixture.paths.outcome)).toBe(false)
						expect(yield* fs.exists(fixture.paths.prepared)).toBe(false)
					} else expect(fixture.api.writes).toEqual([])
					if (
						[
							'draft',
							'closed',
							'moved',
							'fork',
							'missing agent',
							'skip label',
						].includes(scenario)
					)
						expect(fixture.api.commentReads).toEqual([])
				})
		)
	for (const handles of [
		{},
		{ MNG_REVIEW_APP_SLUG: 'mng-review', MNG_REVIEW_HANDLE: 'review-helper' },
	])
		test.effect(
			`invalid handle inputs ${JSON.stringify(handles)} exit two without a request`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					expect(
						yield* runReserveStep.pipe(
							Effect.provide(
								PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
							),
							Effect.provide(fixture.publisherLayer),
							Effect.catchTag('ConfigError', failReserveConfig),
							Effect.provide(
								fixture.envLayer(Object.fromEntries(Object.entries(handles)))
							),
							Effect.flip
						)
					).toMatchObject({ _tag: 'ActionExit', code: 2 })
					expect(fixture.api.reads).toEqual([])
					expect(fixture.api.commentReads).toEqual([])
					expect(fixture.api.writes).toEqual([])
					expect(
						yield* (yield* FileSystem.FileSystem).readFileString(
							fixture.paths.output
						)
					).toBe('reserved=false\n')
				})
		)
	test.effect('a minted slug mismatch exits two before any GitHub read', () =>
		Effect.gen(function* () {
			const fixture = stepFixture([], true)
			expect(
				yield* GitHubConfig.pipe(
					Effect.provide(GitHubWriteConfigLive),
					Effect.flatMap(() =>
						runReserveStep.pipe(
							Effect.provide(
								PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
							),
							Effect.provide(fixture.publisherLayer)
						)
					),
					Effect.catchTag('ConfigError', failReserveConfig),
					Effect.provide(
						fixture.envLayer({
							GITHUB_TOKEN: '',
							MNG_REVIEW_APP_SLUG: 'mng-review',
							MNG_REVIEW_APP_TOKEN: 'app-fixture',
							MNG_REVIEW_MINTED_APP_SLUG: 'other-app',
						})
					),
					Effect.flip
				)
			).toMatchObject({ _tag: 'ActionExit', code: 2 })
			expect(fixture.api.reads).toEqual([])
			expect(fixture.api.commentReads).toEqual([])
			expect(fixture.api.threadReads).toEqual([])
			expect(fixture.api.writes).toEqual([])
			expect(fixture.loads).toEqual([])
			expect(
				yield* (yield* FileSystem.FileSystem).readFileString(
					fixture.paths.output
				)
			).toBe('reserved=false\n')
		})
	)
})

layer(FileSystemLayer)('reserve step list completeness', test => {
	for (const riskEnabled of [false, true])
		test.effect(
			`the count reads complete lists only while the rules rate: ${riskEnabled}`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture(
						[],
						true,
						false,
						undefined,
						undefined,
						undefined,
						riskEnabled
					)
					const pr = fixture.api.command.pullRequest
					fixture.api.command.pullRequest = {
						...pr,
						base: { ...pr.base, sha: fixture.base },
						head: { ...pr.head, sha: fixture.head },
					}
					const seen: boolean[] = []
					const reserveManualRunSpy = vi.fn(() =>
						ListCompleteness.pipe(
							Effect.map(reading => {
								seen.push(reading.complete)
								return true
							})
						)
					)
					yield* runReserveStep.pipe(
						Effect.provide(
							PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
						),
						Effect.provide(
							Layer.succeed(SummaryReviewService, {
								write: () => Effect.die('the reserve step never publishes'),
								readPrior: () =>
									Effect.die('the reserve step reads no prior run'),
								publishStatus: () =>
									Effect.die('the reserve step writes no status'),
								readWaiting: () =>
									Effect.die('the reserve step reads no waiting list'),
								reserveManualRun: reserveManualRunSpy,
							})
						),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(
							fixture.envLayer({
								MNG_REVIEW_APP_SLUG: 'mng-review',
								MNG_REVIEW_TARGET_PR: '17',
								MNG_REVIEW_TARGET_BASE: fixture.base,
								MNG_REVIEW_TARGET_HEAD: fixture.head,
							})
						)
					)
					expect(reserveManualRunSpy).toHaveBeenCalledOnce()
					expect(seen).toEqual([riskEnabled])
				})
		)
})
