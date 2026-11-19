import { layer } from '@effect/vitest'
import type { AgentRunReport, ReviewReport } from '@mng-review/engine'
import { Effect, Layer } from 'effect'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubStatusFake } from '../../../shared/mocks/github-status-fake.helper'
import { bug, report } from '../../../shared/mocks/publish-test.helper'
import {
	StatusReportService,
	StatusReportServiceLive,
} from './status-report.service'

/** Complete agent report for a planned model, with independently selectable outcome. */
function agentReport(status: AgentRunReport['status'] = 'ok'): AgentRunReport {
	return {
		name: 'reviewer',
		title: 'Main reviewer',
		kind: 'bug',
		model: 'model-a',
		effort: 'high',
		status,
		toolCalls: 0,
		findings: 0,
		malformed: 0,
		wallMillis: 1,
	}
}

layer(Layer.empty)('StatusReportService', test => {
	for (const scenario of ['clean', 'bug', 'nit', 'failed', 'missing'] as const)
		test.effect(
			`${scenario} agent has a nonblocking check with the right conclusion`,
			() =>
				Effect.gen(function* () {
					const fixture = report()
					const fake = githubStatusFake()
					const reviewed: ReviewReport = {
						...fixture,
						bugs: scenario === 'bug' ? [bug()] : [],
						nits: scenario === 'nit' ? [bug({ kind: 'nit' })] : [],
						agents:
							scenario === 'missing'
								? []
								: [agentReport(scenario === 'failed' ? 'failed' : 'ok')],
						planReport: {
							...fixture.planReport,
							plan: {
								...fixture.planReport.plan,
								runs: fixture.planReport.plan.runs.map(run => ({
									...run,
									model: 'model-a',
								})),
							},
						},
					}
					expect(
						yield* StatusReportService.use(service =>
							service.report({
								head: 'head',
								report: reviewed,
								verdict: 'ready',
								openBugs: 0,
							})
						).pipe(
							Effect.provide(
								StatusReportServiceLive.pipe(Layer.provide(fake.layer))
							)
						)
					).toEqual({ checks: 1, status: true })
					expect(fake.checks).toEqual([
						expect.objectContaining({
							headSha: 'head',
							name: 'MNG Review · reviewer',
							conclusion: scenario === 'clean' ? 'success' : 'neutral',
						}),
					])
					expect(fake.statuses).toEqual([
						{
							sha: 'head',
							state: 'success',
							description: 'no open bug thread',
						},
					])
				})
		)
	test.effect(
		'writes only one check for duplicate agent names and counts failed writes out',
		() =>
			Effect.gen(function* () {
				const fixture = report()
				const [run] = fixture.planReport.plan.runs
				expect(run).toBeDefined()
				if (!run) return
				const failure = new GitHubApiError({
					operation: 'write',
					reason: 'denied',
					status: 403,
				})
				const fake = githubStatusFake({
					createCheckRun: input =>
						input.name.endsWith('reviewer')
							? Effect.fail(failure)
							: Effect.void,
					setStatus: () => Effect.fail(failure),
				})
				const reviewed = {
					...fixture,
					bugs: [],
					planReport: {
						...fixture.planReport,
						plan: {
							...fixture.planReport.plan,
							runs: [
								run,
								{ ...run, model: 'second' },
								{ ...run, name: 'storage' },
							],
						},
					},
				}
				expect(
					yield* StatusReportService.use(service =>
						service.report({
							head: 'head',
							report: reviewed,
							verdict: 'needs fixes',
							openBugs: 3,
						})
					).pipe(
						Effect.provide(
							StatusReportServiceLive.pipe(Layer.provide(fake.layer))
						)
					)
				).toEqual({ checks: 1, status: false })
				expect(fake.checks.map(input => input.name)).toEqual([
					'MNG Review · reviewer',
					'MNG Review · storage',
				])
				expect(fake.statuses).toContainEqual({
					sha: 'head',
					state: 'failure',
					description: '3 open bug thread(s); needs fixes',
				})
			})
	)
	test.effect.fails(
		'a reviewer whose second model failed must have a neutral check',
		() =>
			Effect.gen(function* () {
				const fixture = report()
				const [run] = fixture.planReport.plan.runs
				expect(run).toBeDefined()
				if (!run) return
				const fake = githubStatusFake()
				const reviewed = {
					...fixture,
					bugs: [],
					agents: [
						agentReport(),
						{ ...agentReport('failed'), model: 'model-b' },
					],
					planReport: {
						...fixture.planReport,
						plan: {
							...fixture.planReport.plan,
							runs: [
								{ ...run, model: 'model-a' },
								{ ...run, model: 'model-b' },
							],
						},
					},
				}
				yield* StatusReportService.use(service =>
					service.report({
						head: 'head',
						report: reviewed,
						verdict: 'incomplete',
						openBugs: 0,
					})
				).pipe(
					Effect.provide(
						StatusReportServiceLive.pipe(Layer.provide(fake.layer))
					)
				)
				expect(fake.checks).toEqual([
					expect.objectContaining({ conclusion: 'neutral' }),
				])
			})
	)
})
