import { layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'
import { HttpClient } from 'effect/http'
import { GitService } from '../../../../platform/git/git.service'
import {
	makeScriptedLlmLayer,
	type ScriptedLlmCall,
} from '../../../../platform/llm/scripted-llm.layer'
import { TokenLedgerLive } from '../../../../platform/llm/token-ledger.service'
import { config, pr } from '../../../../shared/mocks/domain-test.helper'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../../shared/mocks/git-test.helper'
import { gitFixture } from '../../../../shared/mocks/review-layer.helper'
import { answer } from '../../../../shared/mocks/review-test.helper'
import {
	makeReviewLayer,
	ReviewPipelineLive,
} from '../../infrastructure/review.layers'
import { ReviewLimits } from '../review-limits.context'
import { ReviewRunService, ReviewRunServiceLive } from './review-run.service'

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
			test.effect(`${sinceCase} narrows only a distinct ancestor`, () =>
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
									models: { reviewer: [{ model: 'model-a', effort: 'high' }] },
								}),
								agents: [],
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
					expect(report.planReport.change.files.map(file => file.path)).toEqual(
						['src/a.ts', 'src/b.ts']
					)
					expect(report.planReport.plan.runs[0]?.files).toEqual(
						sinceCase === 'ancestor' ? ['src/b.ts'] : ['src/a.ts', 'src/b.ts']
					)
					expect(scriptSpy).toHaveBeenCalledTimes(1)
				})
			)
	}
)
