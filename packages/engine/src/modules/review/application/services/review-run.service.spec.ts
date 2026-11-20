import { layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'
import { HttpClient } from 'effect/http'
import { GitService } from '../../../../platform/git/git.service'
import {
	makeScriptedLlmLayer,
	ScriptedLlm,
	type ScriptedLlmCall,
} from '../../../../platform/llm/scripted-llm.layer'
import { TokenLedgerLive } from '../../../../platform/llm/token-ledger.service'
import { config, pr, agent } from '../../../../shared/mocks/domain-test.helper'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../../shared/mocks/git-test.helper'
import { gitFixture } from '../../../../shared/mocks/review-layer.helper'
import { answer } from '../../../../shared/mocks/review-test.helper'
import { toEmptyReviewReport } from '../../domain/review-report.helper'
import {
	makeReviewLayer,
	ReviewPipelineLive,
} from '../../infrastructure/review.layers'
import { ReviewLimits } from '../review-limits.context'
import { ReviewRunService, ReviewRunServiceLive } from './review-run.service'
import { ReviewService, type ReviewRequest } from './review.service'

vi.mock('../../../../platform/llm/llm.layer', async () => {
	const { Layer: EffectLayer } = await import('effect')
	const { LlmService } = await import('../../../../platform/llm/llm.service')
	return { LlmLive: EffectLayer.effect(LlmService, LlmService) }
})

vi.mock('../../infrastructure/review.layers', async importOriginal => ({
	...(await importOriginal<
		typeof import('../../infrastructure/review.layers')
	>()),
	makeReviewLayer: vi.fn(() =>
		Layer.effectDiscard(
			Effect.die('review layer must not be built for an empty plan')
		)
	),
}))

afterEach(() => {
	cleanupRepos()
	vi.clearAllMocks()
})

layer(Layer.empty)('ReviewRunService', test => {
	for (const mode of ['skipped', 'empty'] as const)
		test.effect(
			`${mode} plan returns an empty report without building the review layer`,
			() =>
				Effect.gen(function* () {
					const makeReviewLayerSpy = vi.mocked(makeReviewLayer)
					const git = gitFixture()
					const readChangeSpy = vi.fn((baseRef: string, headRef: string) =>
						git
							.readChange(baseRef, headRef)
							.pipe(
								Effect.map(change =>
									mode === 'empty' ? { ...change, files: [] } : change
								)
							)
					)
					const rules = {
						config: config({ skip: { labels: ['skip-review'] } }),
						agents: [],
						source: 'base-sha',
					}
					const http = HttpClient.make(() => Effect.die('HTTP must not run'))
					const services = ReviewRunServiceLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								TokenLedgerLive,
								Layer.succeed(GitService, {
									...git,
									readChange: readChangeSpy,
								}),
								Layer.succeed(HttpClient.HttpClient, http)
							)
						)
					)
					const report = yield* ReviewRunService.use(service =>
						service.run({
							rules,
							baseRef: 'base-ref',
							headRef: 'head-ref',
							pr: pr({ labels: mode === 'skipped' ? ['skip-review'] : [] }),
							routerDisabledReason: 'test router disabled',
						})
					).pipe(
						Effect.provide(services),
						Effect.provide(
							ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))
						)
					)
					expect(readChangeSpy).toHaveBeenCalledExactlyOnceWith(
						'base-ref',
						'head-ref'
					)
					expect(report).toMatchObject({
						bugs: [],
						nits: [],
						rejected: [],
						agents: [],
						tokens: {},
						tokenSources: {},
						droppedModels: [],
						blocking: false,
						wallMillis: 0,
						planReport: { rulesSource: 'base-sha', plan: { runs: [] } },
					})
					if (mode === 'skipped')
						expect(report.planReport.plan.skippedRun).toBe(
							'label skip-review is in skip.labels'
						)
					expect(makeReviewLayerSpy).not.toHaveBeenCalled()
				})
		)
})

layer(Layer.empty, { excludeTestServices: true })(
	'ReviewRunService incremental history',
	test => {
		for (const sinceCase of [
			'ancestor',
			'base',
			'non-ancestor',
			'unknown',
			'same-head',
		] as const)
			test.effect(
				`${sinceCase} narrows only declared agents with a distinct ancestor`,
				() =>
					Effect.gen(function* () {
						const repo = createRepo()
						repo.write('src/a.ts', 'base a\n')
						repo.write('src/b.ts', 'base b\n')
						const base = repo.commit()
						repo.write('src/a.ts', 'middle a\n')
						repo.write('src/b.ts', 'middle b\n')
						const middle = repo.commit()
						repo.write('src/b.ts', 'head b\n')
						const head = repo.commit()
						repo.git('checkout', '-b', 'other', base)
						repo.write('src/other.ts', 'other\n')
						const other = repo.commit()
						repo.git('checkout', 'main')
						const commits = {
							ancestor: middle,
							base,
							'non-ancestor': other,
							unknown: 'missing-commit',
							'same-head': head,
						} as const
						const scriptSpy = vi.fn((_call: ScriptedLlmCall) =>
							Effect.succeed(answer())
						)
						vi.mocked(makeReviewLayer).mockImplementation(limits =>
							ReviewPipelineLive.pipe(
								Layer.provide(makeScriptedLlmLayer(scriptSpy)),
								Layer.provide(Layer.succeed(ReviewLimits, limits))
							)
						)
						const services = ReviewRunServiceLive.pipe(
							Layer.provide(
								Layer.mergeAll(
									gitLayer(repo.root),
									TokenLedgerLive,
									Layer.succeed(
										HttpClient.HttpClient,
										HttpClient.make(() => Effect.die('HTTP must not run'))
									)
								)
							)
						)
						const report = yield* ReviewRunService.use(service =>
							service.run({
								rules: {
									config: config({
										models: {
											reviewer: [{ model: 'model-a', effort: 'high' }],
										},
									}),
									agents: [agent('storage', { input: 'incremental' })],
									source: base,
								},
								baseRef: base,
								headRef: head,
								since: commits[sinceCase],
								pr: pr(),
								routerDisabledReason: 'fixture',
							})
						).pipe(
							Effect.provide(services),
							Effect.provide(
								ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))
							)
						)
						expect(
							report.planReport.change.files.map(file => file.path)
						).toEqual(['src/a.ts', 'src/b.ts'])
						expect(report.planReport.plan.runs[0]?.files).toEqual([
							'src/a.ts',
							'src/b.ts',
						])
						expect(
							report.planReport.plan.runs.find(run => run.name === 'storage')
								?.files
						).toEqual(
							sinceCase === 'ancestor' ? ['src/b.ts'] : ['src/a.ts', 'src/b.ts']
						)
						expect(scriptSpy).toHaveBeenCalledTimes(2)
					})
			)
	}
)

layer(Layer.empty)('ReviewRunService command agent selection', test => {
	for (const selectedByPaths of [false, true])
		test.effect(
			`onlyAgent narrows the real plan, selected by paths=${selectedByPaths}`,
			() =>
				Effect.gen(function* () {
					const reviewSpy = vi.fn((request: ReviewRequest) =>
						Effect.succeed(toEmptyReviewReport(request.planReport, 0))
					)
					vi.mocked(makeReviewLayer).mockImplementationOnce(() =>
						Layer.succeed(ReviewService, { review: reviewSpy })
					)
					const services = ReviewRunServiceLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								TokenLedgerLive,
								Layer.succeed(GitService, gitFixture()),
								Layer.succeed(
									HttpClient.HttpClient,
									HttpClient.make(() => Effect.die('HTTP must not run'))
								)
							)
						)
					)
					const report = yield* ReviewRunService.use(service =>
						service.run({
							rules: {
								config: config(),
								agents: [
									agent('storage', {
										when: {
											paths: [selectedByPaths ? 'src/**' : 'unmatched/**'],
										},
									}),
									agent('security'),
								],
								source: 'base-sha',
							},
							baseRef: 'base-ref',
							headRef: 'head-ref',
							pr: pr({ trigger: 'manual' }),
							routerDisabledReason: 'fixture',
							onlyAgent: 'storage',
						})
					).pipe(
						Effect.provide(services),
						Effect.provide(
							ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))
						)
					)
					expect(report.planReport.plan.runs).toEqual([
						expect.objectContaining({
							name: 'storage',
							role: 'agent',
							files: ['src/billing/charge.ts'],
							...(selectedByPaths ? {} : { reason: 'requested by a command' }),
						}),
					])
					expect(report.planReport.plan.skips).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								name: 'reviewer',
								reason: 'a command asked for another agent',
							}),
							expect.objectContaining({
								name: 'security',
								reason: 'a command asked for another agent',
							}),
						])
					)
					expect(reviewSpy).toHaveBeenCalledOnce()
					expect(reviewSpy.mock.calls[0]?.[0].planReport.plan).toEqual(
						report.planReport.plan
					)
				})
		)
	for (const gatedBy of ['draft', 'label'] as const)
		test.effect(`onlyAgent cannot bypass a ${gatedBy} gate`, () =>
			Effect.gen(function* () {
				const services = ReviewRunServiceLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							TokenLedgerLive,
							Layer.succeed(GitService, gitFixture()),
							Layer.succeed(
								HttpClient.HttpClient,
								HttpClient.make(() => Effect.die('HTTP must not run'))
							)
						)
					)
				)
				const report = yield* ReviewRunService.use(service =>
					service.run({
						rules: {
							config: config(),
							agents: [agent('storage')],
							source: 'base-sha',
						},
						baseRef: 'base-ref',
						headRef: 'head-ref',
						pr: pr({
							trigger: 'manual',
							draft: gatedBy === 'draft',
							labels: gatedBy === 'label' ? ['skip-review'] : [],
						}),
						routerDisabledReason: 'fixture',
						onlyAgent: 'storage',
					})
				).pipe(
					Effect.provide(services),
					Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))
				)
				expect(report.planReport.plan.skippedRun).toBeTruthy()
				expect(report.planReport.plan.runs).toEqual([])
				expect(makeReviewLayer).not.toHaveBeenCalled()
			})
		)
})

layer(Layer.empty)('ReviewRunService undeclared command agents', test => {
	for (const onlyAgent of ['missing-agent', 'Storage', 'storage extra', ''])
		test.effect(
			`onlyAgent=${JSON.stringify(onlyAgent)} skips every model call including routing`,
			() =>
				Effect.gen(function* () {
					const services = ReviewRunServiceLive.pipe(
						Layer.provideMerge(
							makeScriptedLlmLayer(() => Effect.succeed(answer()))
						),
						Layer.provide(
							Layer.mergeAll(
								TokenLedgerLive,
								Layer.succeed(GitService, gitFixture()),
								Layer.succeed(
									HttpClient.HttpClient,
									HttpClient.make(() => Effect.die('HTTP must not run'))
								)
							)
						)
					)
					yield* Effect.gen(function* () {
						const report = yield* ReviewRunService.use(service =>
							service.run({
								rules: {
									config: config(),
									agents: [
										agent('storage', { when: { paths: ['unmatched/**'] } }),
										agent('security'),
									],
									source: 'base-sha',
								},
								baseRef: 'base-ref',
								headRef: 'head-ref',
								pr: pr({ trigger: 'manual' }),
								onlyAgent,
							})
						)
						expect(report.planReport.plan.skippedRun).toBe(
							onlyAgent === 'missing-agent'
								? 'a command named agent missing-agent, which the rules do not declare'
								: 'a command named an agent, which the rules do not declare'
						)
						expect(report.planReport.plan.runs).toEqual([])
						expect(report.planReport.plan.skips).toEqual([])
						expect(report.planReport.plan.router).toMatchObject({
							status: 'failed',
							detail: 'a command named an undeclared agent',
						})
						expect(report).toMatchObject({
							bugs: [],
							nits: [],
							agents: [],
							tokens: {},
							blocking: false,
						})
						expect(yield* ScriptedLlm.use(model => model.calls)).toEqual([])
						expect(makeReviewLayer).not.toHaveBeenCalled()
					}).pipe(
						Effect.provide(services),
						Effect.provide(
							ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))
						)
					)
				})
		)
	test.effect('a declared command agent still reaches the scripted model', () =>
		Effect.gen(function* () {
			const scriptedLlmLayer = makeScriptedLlmLayer(() =>
				Effect.succeed(answer())
			)
			vi.mocked(makeReviewLayer).mockImplementationOnce(limits =>
				ReviewPipelineLive.pipe(
					Layer.provide(scriptedLlmLayer),
					Layer.provide(Layer.succeed(ReviewLimits, limits))
				)
			)
			const services = ReviewRunServiceLive.pipe(
				Layer.provideMerge(scriptedLlmLayer),
				Layer.provide(
					Layer.mergeAll(
						TokenLedgerLive,
						Layer.succeed(GitService, gitFixture()),
						Layer.succeed(
							HttpClient.HttpClient,
							HttpClient.make(() => Effect.die('HTTP must not run'))
						)
					)
				)
			)
			yield* Effect.gen(function* () {
				const report = yield* ReviewRunService.use(service =>
					service.run({
						rules: {
							config: config(),
							agents: [agent('storage')],
							source: 'base-sha',
						},
						baseRef: 'base-ref',
						headRef: 'head-ref',
						pr: pr({ trigger: 'manual' }),
						routerDisabledReason: 'fixture',
						onlyAgent: 'storage',
					})
				)
				expect(report.planReport.plan.skippedRun).toBeUndefined()
				expect(report.planReport.plan.runs.map(run => run.name)).toEqual([
					'storage',
				])
				expect(report.agents).toEqual([
					expect.objectContaining({ name: 'storage', status: 'ok' }),
				])
				expect(yield* ScriptedLlm.use(model => model.calls)).toHaveLength(1)
			}).pipe(
				Effect.provide(services),
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))
			)
		})
	)
})
