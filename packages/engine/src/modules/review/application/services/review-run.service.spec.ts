import { layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'
import { HttpClient } from 'effect/http'
import { GitService } from '../../../../platform/git/git.service'
import { TokenLedgerLive } from '../../../../platform/llm/token-ledger.service'
import { config, pr } from '../../../../shared/mocks/domain-test.helper'
import { gitFixture } from '../../../../shared/mocks/review-layer.helper'
import { makeReviewLayer } from '../../infrastructure/review.layers'
import { ReviewRunService, ReviewRunServiceLive } from './review-run.service'

vi.mock('../../infrastructure/review.layers', () => ({
	makeReviewLayer: vi.fn(() =>
		Layer.effectDiscard(
			Effect.die('review layer must not be built for an empty plan')
		)
	),
}))

afterEach(() => {
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
