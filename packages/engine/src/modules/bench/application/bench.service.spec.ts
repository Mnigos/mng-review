import { NodePath } from '@effect/platform-node-shared'
import { layer } from '@effect/vitest'
import { BENCH_FILE_VERSION, DEFAULT_LINE_WINDOW } from '@mng-review/domain'
import { Effect, FileSystem, Layer } from 'effect'
import { HttpClient } from 'effect/http'
import { RulesService } from '../../../platform/config/rules.service'
import { GitService, GitWorkdir } from '../../../platform/git/git.service'
import { gitFixture } from '../../../shared/mocks/review-layer.helper'
import { reviewRequest } from '../../../shared/mocks/review-test.helper'
import { reviewChange } from '../../review/application/services/review-run.service'
import { toEmptyReviewReport } from '../../review/domain/review-report.helper'
import type { AgentRunReport } from '../../review/domain/review-report.types'
import { BenchService, BenchServiceLive } from './bench.service'

vi.mock('../../review/application/services/review-run.service', () => ({
	reviewChange: vi.fn(),
}))

const REQUEST = {
	file: 'bench.json',
	caseIds: [],
	lineWindow: DEFAULT_LINE_WINDOW,
	concurrency: 1,
} as const
const CASES = {
	version: BENCH_FILE_VERSION,
	cases: [{ id: 'charge', base: 'base', head: 'head', expected: [] }],
} as const
const AGENT = {
	name: 'reviewer',
	title: 'Main reviewer',
	model: 'review-model',
	effort: 'high',
	kind: 'bug',
	status: 'ok',
	toolCalls: 7,
	findings: 2,
	malformed: 0,
	wallMillis: 25,
} as const satisfies AgentRunReport

/** All outside reads are fixtures; no HTTP request or git command runs. */
const BenchTest = BenchServiceLive.pipe(
	Layer.provide(
		Layer.mergeAll(
			Layer.succeed(RulesService, {
				load: () => Effect.succeed(reviewRequest().rules),
			}),
			FileSystem.layerNoop({
				readFileString: () => Effect.succeed(JSON.stringify(CASES)),
			}),
			NodePath.layer,
			Layer.succeed(GitWorkdir, { cwd: '/repo' }),
			Layer.succeed(GitService, gitFixture()),
			Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make(() => Effect.die('unexpected network call'))
			)
		)
	)
)

layer(BenchTest)('benchmark finder rows', test => {
	for (const extra of [
		{},
		{
			units: 3,
			continued: 1,
			unfinished: ['src/billing/refund.ts'],
			status: 'incomplete',
		},
	] as const)
		test.effect(
			`copies finder counts ${'units' in extra ? 'with' : 'without'} optional coverage fields`,
			() =>
				Effect.gen(function* () {
					const report = toEmptyReviewReport(reviewRequest().planReport, 25)
					vi.mocked(reviewChange).mockReturnValue(
						Effect.succeed({
							...report,
							agents: [
								{ ...AGENT, ...extra },
								{
									...AGENT,
									name: 'billing',
									model: 'agent-model',
									toolCalls: 0,
									findings: 0,
								},
							],
						})
					)
					const bench = yield* BenchService.use(service => service.run(REQUEST))
					expect(bench.cases[0]?.agents).toEqual([
						{
							name: 'reviewer',
							model: 'review-model',
							status: 'ok',
							toolCalls: 7,
							findings: 2,
							...extra,
						},
						{
							name: 'billing',
							model: 'agent-model',
							status: 'ok',
							toolCalls: 0,
							findings: 0,
						},
					])
				})
		)
	test.effect('a case with no finder reports has an empty agent array', () =>
		Effect.gen(function* () {
			vi.mocked(reviewChange).mockReturnValue(
				Effect.succeed(toEmptyReviewReport(reviewRequest().planReport, 0))
			)
			expect(
				(yield* BenchService.use(service => service.run(REQUEST))).cases[0]
					?.agents
			).toEqual([])
		})
	)
})
