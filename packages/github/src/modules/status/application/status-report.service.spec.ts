import { layer } from '@effect/vitest'
import type { ReviewReport } from '@mng-review/engine'
import { Effect, Layer } from 'effect'
import { GitHubApiError } from '../../../platform/github.errors'
import {
	collectListed,
	provideListCompleteness,
} from '../../../platform/list-completeness.context'
import { githubStatusFake } from '../../../shared/mocks/github-status-fake.helper'
import {
	bug,
	report,
	agentReport,
	TOKEN_MODE_OWNED,
} from '../../../shared/mocks/publish-test.helper'
import { isFinished } from '../../publish/domain/bot-thread.helper'
import {
	toCommitStatus,
	toIncompleteDescription,
	UNFINISHED_NOTE,
} from '../domain/status.helper'
import {
	StatusReportService,
	StatusReportServiceLive,
} from './status-report.service'

layer(TOKEN_MODE_OWNED)('StatusReportService', test => {
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
								finished: isFinished(reviewed),
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
							state: scenario === 'failed' ? 'error' : 'success',
							description:
								scenario === 'failed'
									? `no open bug thread; ${UNFINISHED_NOTE}`
									: 'no open bug thread',
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
							finished: isFinished(reviewed),
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
	test.effect(
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
						finished: isFinished(reviewed),
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

layer(TOKEN_MODE_OWNED)('StatusReportService unfinished and offline', test => {
	for (const stopped of ['endpoint', 'budget', 'failed', 'incomplete'] as const)
		for (const openBugs of [0, 1])
			test.effect(
				`${stopped} with ${openBugs} open bugs keeps the unfinished note`,
				() =>
					Effect.gen(function* () {
						const fake = githubStatusFake()
						const reviewed: ReviewReport = {
							...report(),
							bugs: [],
							agents: [
								agentReport(
									stopped === 'failed' || stopped === 'incomplete'
										? stopped
										: 'ok'
								),
							],
							...(stopped === 'endpoint' ? { endpointError: 'offline' } : {}),
							...(stopped === 'budget'
								? {
										incomplete: {
											reason: 'budget spent',
											unfinished: ['reviewer'],
										},
									}
								: {}),
						}
						yield* StatusReportService.use(service =>
							service.report({
								head: 'head',
								report: reviewed,
								verdict: openBugs ? 'needs fixes' : 'ready',
								openBugs,
								finished: isFinished(reviewed),
							})
						).pipe(
							Effect.provide(
								StatusReportServiceLive.pipe(Layer.provide(fake.layer))
							)
						)
						expect(fake.statuses).toEqual([
							{
								sha: 'head',
								state: openBugs ? 'failure' : 'error',
								description: openBugs
									? `1 open bug thread(s); needs fixes; ${UNFINISHED_NOTE}`
									: `no open bug thread; ${UNFINISHED_NOTE}`,
							},
						])
					})
			)
	for (const fail of [true, false])
		test.effect(
			`offline reports an error and returns write success=${!fail}`,
			() =>
				Effect.gen(function* () {
					const fake = githubStatusFake({
						setStatus: () =>
							fail
								? Effect.fail(
										new GitHubApiError({
											operation: 'status',
											reason: 'denied',
										})
									)
								: Effect.void,
					})
					expect(
						yield* StatusReportService.use(service =>
							service.reportOffline('head')
						).pipe(
							Effect.provide(
								StatusReportServiceLive.pipe(Layer.provide(fake.layer))
							)
						)
					).toBe(!fail)
					expect(fake.statuses).toEqual([
						{
							sha: 'head',
							state: 'error',
							description: `the reviewer was offline; ${UNFINISHED_NOTE}`,
						},
					])
					expect(fake.checks).toEqual([])
				})
		)
	for (const fail of [true, false])
		test.effect(
			`unfinished publishing reports an error and returns write success=${!fail}`,
			() =>
				Effect.gen(function* () {
					const fake = githubStatusFake({
						setStatus: () =>
							fail
								? Effect.fail(
										new GitHubApiError({
											operation: 'setStatus',
											reason: 'status denied',
											status: 403,
										})
									)
								: Effect.void,
					})
					expect(
						yield* StatusReportService.use(service =>
							service.reportUnfinished('head')
						).pipe(
							Effect.provide(
								StatusReportServiceLive.pipe(Layer.provide(fake.layer))
							)
						)
					).toBe(!fail)
					expect(fake.statuses).toEqual([
						{
							sha: 'head',
							state: 'error',
							description: `publishing failed; ${UNFINISHED_NOTE}`,
						},
					])
					expect(fake.checks).toEqual([])
				})
		)
	for (const statuses of [
		['ok', 'ok'],
		['failed', 'ok'],
		['ok', 'failed'],
	] as const)
		test.effect(`reviewer models ${statuses.join('/')} share one check`, () =>
			Effect.gen(function* () {
				const fixture = report()
				const fake = githubStatusFake()
				const reviewed = {
					...fixture,
					bugs: [],
					agents: statuses.map((status, index) => ({
						...agentReport(status),
						model: `model-${index}`,
					})),
					planReport: {
						...fixture.planReport,
						plan: {
							...fixture.planReport.plan,
							runs: fixture.planReport.plan.runs.flatMap(run =>
								statuses.map((_, index) => ({
									...run,
									model: `model-${index}`,
								}))
							),
						},
					},
				}
				yield* StatusReportService.use(service =>
					service.report({
						head: 'head',
						report: reviewed,
						verdict: 'ready',
						openBugs: 0,
						finished: isFinished(reviewed),
					})
				).pipe(
					Effect.provide(
						StatusReportServiceLive.pipe(Layer.provide(fake.layer))
					)
				)
				expect(fake.checks).toEqual([
					expect.objectContaining({
						name: 'MNG Review · reviewer',
						conclusion: statuses.every(status => status === 'ok')
							? 'success'
							: 'neutral',
					}),
				])
			})
		)
})

layer(TOKEN_MODE_OWNED)('StatusReportService full review completion', test => {
	for (const finished of [false, true])
		for (const openBugs of [0, 2])
			test.effect(
				`the status uses explicit finished=${finished} and ${openBugs} bugs independently of this report`,
				() =>
					Effect.gen(function* () {
						const fake = githubStatusFake()
						const reviewed = {
							...report(),
							bugs: [],
							...(finished ? { endpointError: 'offline' } : {}),
						}
						yield* StatusReportService.use(service =>
							service.report({
								head: 'head',
								report: reviewed,
								verdict: openBugs ? 'needs fixes' : 'ready',
								openBugs,
								finished,
							})
						).pipe(
							Effect.provide(
								StatusReportServiceLive.pipe(Layer.provide(fake.layer))
							)
						)
						expect(fake.statuses).toEqual([
							{
								sha: 'head',
								...toCommitStatus(
									openBugs ? 'needs fixes' : 'ready',
									openBugs,
									finished
								),
							},
						])
					})
			)
})

/** A lenient list read that leaves one null node out, which marks the run incomplete. */
const DROPPED_NODE = collectListed('listReviews', () =>
	Effect.succeed({
		nodes: [null],
		pageInfo: { hasNextPage: false, endCursor: null },
	})
)

/** A clean report of one agent, which a complete run checks as `success`. */
function cleanReport(): ReviewReport {
	const fixture = report()
	return { ...fixture, bugs: [], nits: [], agents: [agentReport('ok')] }
}

layer(TOKEN_MODE_OWNED)('StatusReportService incomplete list reads', test => {
	const existing = {
		id: 1,
		state: 'failure',
		description: '1 open bug thread(s); needs fixes',
		context: 'MNG Review',
		creator: null,
	} as const
	const pending = [
		{
			sha: 'head',
			state: 'pending',
			description: toIncompleteDescription(['reviews']),
		},
	] as const
	for (const [name, previous, written] of [
		[
			'on a head with no status writes pending with the reason',
			undefined,
			pending,
		],
		['leaves a failure the head has', existing, []],
		[
			'turns the success the head has into pending',
			{ ...existing, ...toCommitStatus('ready', 0, true) },
			pending,
		],
	] as const)
		test.effect(
			`a ready incomplete run ${name} and checks nothing as success`,
			() =>
				Effect.gen(function* () {
					const fake = githubStatusFake({
						getStatus: () => Effect.succeed(previous),
					})
					expect(
						yield* DROPPED_NODE.pipe(
							Effect.andThen(
								StatusReportService.use(service =>
									service.report({
										head: 'head',
										report: cleanReport(),
										verdict: 'ready',
										openBugs: 0,
										finished: true,
									})
								)
							),
							Effect.provide(
								StatusReportServiceLive.pipe(Layer.provide(fake.layer))
							),
							provideListCompleteness(false)
						)
					).toEqual({ checks: 1, status: true })
					expect(fake.statuses).toEqual(written)
					expect(fake.heads).toEqual(['head'])
					expect(fake.checks.map(check => check.conclusion)).toEqual([
						'neutral',
					])
				})
		)
	for (const verdict of ['needs fixes', 'needs owner'] as const)
		test.effect(
			`an incomplete ${verdict} run writes failure as a complete one does`,
			() =>
				Effect.gen(function* () {
					const fake = githubStatusFake()
					yield* DROPPED_NODE.pipe(
						Effect.andThen(
							StatusReportService.use(service =>
								service.report({
									head: 'head',
									report: cleanReport(),
									verdict,
									openBugs: verdict === 'needs fixes' ? 1 : 0,
									finished: true,
								})
							)
						),
						Effect.provide(
							StatusReportServiceLive.pipe(Layer.provide(fake.layer))
						),
						provideListCompleteness(false)
					)
					expect(fake.statuses).toEqual([
						{
							sha: 'head',
							...toCommitStatus(
								verdict,
								verdict === 'needs fixes' ? 1 : 0,
								true
							),
						},
					])
				})
		)
	test.effect('an incomplete run whose status read fails writes nothing', () =>
		Effect.gen(function* () {
			const fake = githubStatusFake({
				getStatus: () =>
					Effect.fail(
						new GitHubApiError({ operation: 'getStatus', reason: 'Denied' })
					),
			})
			expect(
				yield* DROPPED_NODE.pipe(
					Effect.andThen(
						StatusReportService.use(service =>
							service.report({
								head: 'head',
								report: cleanReport(),
								verdict: 'ready',
								openBugs: 0,
								finished: true,
							})
						)
					),
					Effect.provide(
						StatusReportServiceLive.pipe(Layer.provide(fake.layer))
					),
					provideListCompleteness(false)
				)
			).toEqual({ checks: 1, status: false })
			expect(fake.statuses).toEqual([])
		})
	)
	test.effect(
		'an incomplete needs fixes run whose status read fails still writes failure',
		() =>
			Effect.gen(function* () {
				const fake = githubStatusFake({
					getStatus: () =>
						Effect.fail(
							new GitHubApiError({ operation: 'getStatus', reason: 'Denied' })
						),
				})
				expect(
					yield* DROPPED_NODE.pipe(
						Effect.andThen(
							StatusReportService.use(service =>
								service.report({
									head: 'head',
									report: cleanReport(),
									verdict: 'needs fixes',
									openBugs: 1,
									finished: true,
								})
							)
						),
						Effect.provide(
							StatusReportServiceLive.pipe(Layer.provide(fake.layer))
						),
						provideListCompleteness(false)
					)
				).toEqual({ checks: 1, status: true })
				expect(fake.statuses).toEqual([
					{ sha: 'head', ...toCommitStatus('needs fixes', 1, true) },
				])
			})
	)
	test.effect('a complete run reads no status and writes success', () =>
		Effect.gen(function* () {
			const fake = githubStatusFake()
			yield* StatusReportService.use(service =>
				service.report({
					head: 'head',
					report: cleanReport(),
					verdict: 'ready',
					openBugs: 0,
					finished: true,
				})
			).pipe(
				Effect.provide(StatusReportServiceLive.pipe(Layer.provide(fake.layer))),
				provideListCompleteness(false)
			)
			expect(fake.heads).toEqual([])
			expect(fake.statuses).toEqual([
				{ sha: 'head', ...toCommitStatus('ready', 0, true) },
			])
			expect(fake.checks.map(check => check.conclusion)).toEqual(['success'])
		})
	)
})
