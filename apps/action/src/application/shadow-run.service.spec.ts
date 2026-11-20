import { layer } from '@effect/vitest'
import {
	ConfigError,
	DEFAULT_PRESET,
	type ReviewConfig,
} from '@mng-review/domain'
import {
	EndpointProbeService,
	GitError,
	ReviewRunService,
	RulesService,
	RulesServiceLive,
	type EndpointProbe,
	type ReviewRunRequest,
	type Rules,
} from '@mng-review/engine'
import { Effect, Layer } from 'effect'
import * as eventParser from '../infrastructure/pull-request-event.parser'
import {
	cleanupRepos,
	createRepo,
	FileSystemLayer,
	gitLayer,
} from '../shared/mocks/git-test.helper'
import {
	BASE_SHA,
	HEAD_SHA,
	eventPayload,
} from '../shared/mocks/pull-request-event.helper'
import { reviewReport } from '../shared/mocks/review-report.helper'
import { PrepareRunService, PrepareRunServiceLive } from './prepare-run.service'
import { FORK_REASON, getRunLimitReason } from './run-gate.helper'
import { ShadowRunService, ShadowRunServiceLive } from './shadow-run.service'
import type { PreparedRun, ShadowRunInput } from './shadow-run.types'

interface HarnessOptions {
	readonly config?: ReviewConfig
	readonly load?: RulesService['Service']['load']
	readonly review?: ReviewRunService['Service']['run']
	readonly probe?: EndpointProbe
}

/** Only the gate and orchestration are real; every external boundary is a test service. */
function harness(options: HarnessOptions = {}) {
	const rules = {
		config: structuredClone(options.config ?? DEFAULT_PRESET),
		agents: [],
		source: BASE_SHA,
	} satisfies Rules
	const report = reviewReport()
	const loadSpy = vi.fn(options.load ?? (() => Effect.succeed(rules)))
	const runSpy = vi.fn(options.review ?? (() => Effect.succeed(report)))
	const probeSpy = vi.fn(() =>
		Effect.succeed(options.probe ?? ({ status: 'online' } as const))
	)
	const serviceLayer = ShadowRunServiceLive.pipe(
		Layer.provide(PrepareRunServiceLive),
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(RulesService, { load: loadSpy }),
				Layer.succeed(ReviewRunService, { run: runSpy }),
				Layer.succeed(EndpointProbeService, { probe: probeSpy })
			)
		)
	)
	const defaultInput: ShadowRunInput = {
		eventName: 'pull_request_target',
		readEvent: Effect.succeed(JSON.stringify(eventPayload())),
	}
	const run = (input: ShadowRunInput = defaultInput) =>
		ShadowRunService.use(service => service.run(input)).pipe(
			Effect.provide(serviceLayer)
		)
	const prepare = (input: ShadowRunInput = defaultInput) =>
		PrepareRunService.use(service => service.prepare(input)).pipe(
			Effect.provide(PrepareRunServiceLive),
			Effect.provide(Layer.succeed(RulesService, { load: loadSpy }))
		)
	const review = (prepared: PreparedRun) =>
		ShadowRunService.use(service => service.review(prepared)).pipe(
			Effect.provide(serviceLayer)
		)
	return { run, prepare, review, loadSpy, runSpy, probeSpy, rules, report }
}

afterEach(() => {
	cleanupRepos()
	vi.restoreAllMocks()
})

layer(Layer.empty)('ShadowRunService', test => {
	for (const eventName of ['push', 'workflow_dispatch', ''])
		test.effect(
			`${eventName || 'unknown'} skips without reading the event or calling services`,
			() =>
				Effect.gen(function* () {
					const fixture = harness()
					const readEventSpy = vi.fn(() => 'unread')
					expect(
						yield* fixture.run({
							eventName,
							readEvent: Effect.sync(readEventSpy),
						})
					).toMatchObject({
						status: 'skipped',
						reason: `${eventName || 'unknown'} is not a pull request event`,
					})
					expect(readEventSpy).not.toHaveBeenCalled()
					expect(fixture.loadSpy).not.toHaveBeenCalled()
					expect(fixture.probeSpy).not.toHaveBeenCalled()
					expect(fixture.runSpy).not.toHaveBeenCalled()
				})
		)
	for (const repo of [{ full_name: 'example/fork' }, null])
		test.effect(
			`fork ${repo?.full_name ?? 'deleted'} skips before rules even if skip.forks is false`,
			() =>
				Effect.gen(function* () {
					const fixture = harness({
						config: {
							...DEFAULT_PRESET,
							skip: { ...DEFAULT_PRESET.skip, forks: false },
						},
					})
					const payload = eventPayload()
					expect(
						yield* fixture.run({
							eventName: 'pull_request_target',
							readEvent: Effect.succeed(
								JSON.stringify({
									...payload,
									pull_request: {
										...payload.pull_request,
										head: { ...payload.pull_request.head, repo },
									},
								})
							),
						})
					).toMatchObject({ status: 'skipped', reason: FORK_REASON })
					expect(fixture.loadSpy).not.toHaveBeenCalled()
					expect(fixture.probeSpy).not.toHaveBeenCalled()
					expect(fixture.runSpy).not.toHaveBeenCalled()
				})
		)
	for (const eventName of ['pull_request', 'pull_request_target'])
		test.effect(
			`${eventName} loads base rules and passes both SHAs and metadata to the review`,
			() =>
				Effect.gen(function* () {
					const fixture = harness()
					const outcome = yield* fixture.run({
						eventName,
						readEvent: Effect.succeed(JSON.stringify(eventPayload())),
					})
					expect(outcome).toEqual({
						status: 'reviewed',
						event: {
							action: 'opened',
							number: 17,
							baseSha: BASE_SHA,
							headSha: HEAD_SHA,
							pr: {
								title: 'Update item storage',
								body: 'Keep item writes consistent.',
								author: 'contributor',
								target: 'main',
								labels: ['storage'],
								draft: false,
								fork: false,
								trigger: 'auto',
							},
						},
						report: fixture.report,
						rules: fixture.rules,
					})
					expect(fixture.loadSpy).toHaveBeenCalledExactlyOnceWith(BASE_SHA)
					expect(fixture.probeSpy).toHaveBeenCalledExactlyOnceWith()
					expect(fixture.runSpy).toHaveBeenCalledExactlyOnceWith({
						rules: fixture.rules,
						baseRef: BASE_SHA,
						headRef: HEAD_SHA,
						pr: {
							labels: ['storage'],
							author: 'contributor',
							target: 'main',
							trigger: 'auto',
							draft: false,
							fork: false,
							title: 'Update item storage',
							body: 'Keep item writes consistent.',
						},
					})
				})
		)
	for (const gate of ['labels', 'drafts'] as const)
		test.effect(`skip.${gate} skips before the probe`, () =>
			Effect.gen(function* () {
				const fixture = harness({
					config: {
						...DEFAULT_PRESET,
						skip: { ...DEFAULT_PRESET.skip, labels: ['storage'], drafts: true },
					},
				})
				const payload = eventPayload()
				expect(
					yield* fixture.run({
						eventName: 'pull_request_target',
						readEvent: Effect.succeed(
							JSON.stringify({
								...payload,
								pull_request: {
									...payload.pull_request,
									draft: gate === 'drafts',
								},
							})
						),
					})
				).toMatchObject({
					status: 'skipped',
					reason:
						gate === 'drafts'
							? 'draft pull request (skip.drafts)'
							: 'label storage is in skip.labels',
				})
				expect(fixture.loadSpy).toHaveBeenCalledExactlyOnceWith(BASE_SHA)
				expect(fixture.probeSpy).not.toHaveBeenCalled()
				expect(fixture.runSpy).not.toHaveBeenCalled()
			})
		)
	test.effect('always_review overrides both a skip label and a draft', () =>
		Effect.gen(function* () {
			const fixture = harness({
				config: {
					...DEFAULT_PRESET,
					skip: { ...DEFAULT_PRESET.skip, labels: ['storage'], drafts: true },
					labels: { ...DEFAULT_PRESET.labels, always_review: ['storage'] },
				},
			})
			const payload = eventPayload()
			expect(
				yield* fixture.run({
					eventName: 'pull_request',
					readEvent: Effect.succeed(
						JSON.stringify({
							...payload,
							pull_request: { ...payload.pull_request, draft: true },
						})
					),
				})
			).toMatchObject({ status: 'reviewed' })
			expect(fixture.probeSpy).toHaveBeenCalledOnce()
			expect(fixture.runSpy).toHaveBeenCalledOnce()
		})
	)
	test.effect(
		'an offline probe returns a neutral outcome without reviewing',
		() =>
			Effect.gen(function* () {
				const fixture = harness({
					probe: { status: 'offline', reason: 'unreachable' },
				})
				expect(yield* fixture.run()).toMatchObject({
					status: 'offline',
					reason: 'unreachable',
					event: { baseSha: BASE_SHA },
				})
				expect(fixture.runSpy).not.toHaveBeenCalled()
			})
	)
	for (const stage of ['read', 'parse', 'rules', 'review'] as const)
		test.effect(`maps ConfigError from ${stage} to invalid-config`, () =>
			Effect.gen(function* () {
				const error = new ConfigError({
					source:
						stage === 'read' || stage === 'parse'
							? 'GITHUB_EVENT_PATH'
							: '.mng/review.yml',
					reason: 'invalid fixture',
				})
				const fixture = harness({
					...(stage === 'rules' ? { load: () => Effect.fail(error) } : {}),
					...(stage === 'review' ? { review: () => Effect.fail(error) } : {}),
				})
				const outcome = yield* fixture.run({
					eventName: 'pull_request',
					readEvent:
						stage === 'read'
							? Effect.fail(error)
							: Effect.succeed(
									stage === 'parse' ? '{}' : JSON.stringify(eventPayload())
								),
				})
				expect(outcome).toMatchObject({
					status: 'invalid-config',
					source: error.source,
				})
				if (stage === 'read' || stage === 'parse')
					expect(outcome).not.toHaveProperty('event')
				else
					expect(outcome).toHaveProperty(
						'event',
						yield* eventParser.parsePullRequestEvent(
							JSON.stringify(eventPayload())
						)
					)
				if (outcome.status === 'invalid-config') {
					if (stage === 'parse')
						expect(outcome.reason).toContain('not a pull request event')
					else expect(outcome.reason).toBe(error.reason)
				}
				if (stage !== 'review') expect(fixture.runSpy).not.toHaveBeenCalled()
				if (stage !== 'review') expect(fixture.probeSpy).not.toHaveBeenCalled()
			})
		)
	for (const stage of ['rules', 'review'] as const)
		test.effect(`maps GitError from ${stage} to failed`, () =>
			Effect.gen(function* () {
				const error = new GitError({
					args: ['show', BASE_SHA],
					exitCode: 128,
					stderr: 'missing object',
				})
				const fixture = harness(
					stage === 'rules'
						? { load: () => Effect.fail(error) }
						: { review: () => Effect.fail(error) }
				)
				expect(yield* fixture.run()).toEqual({
					status: 'failed',
					reason: `git: ${error.message}`,
					event: yield* eventParser.parsePullRequestEvent(
						JSON.stringify(eventPayload())
					),
				})
			})
		)
})

layer(FileSystemLayer, { excludeTestServices: true })(
	'ShadowRunService base rules integration',
	test => {
		test.effect(
			'a head rule adding a skip label cannot change the base verdict',
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					repo.write('.mng/review.yml', 'skip:\n  labels: []\n')
					repo.write('src/items.ts', 'export const value = 1\n')
					const baseSha = repo.commit()
					repo.write('.mng/review.yml', 'skip:\n  labels: [storage]\n')
					repo.write('src/items.ts', 'export const value = 2\n')
					const headSha = repo.commit()
					const payload = eventPayload()
					const readEvent = Effect.succeed(
						JSON.stringify({
							...payload,
							pull_request: {
								...payload.pull_request,
								base: { ...payload.pull_request.base, sha: baseSha },
								head: { ...payload.pull_request.head, sha: headSha },
							},
						})
					)
					const rulesLayer = RulesServiceLive.pipe(
						Layer.provide(gitLayer(repo.root)),
						Layer.provide(FileSystemLayer)
					)
					const runSpy = vi.fn((request: ReviewRunRequest) =>
						Effect.succeed({
							...reviewReport(),
							planReport: {
								...reviewReport().planReport,
								rulesSource: request.rules.source,
							},
						})
					)
					const serviceLayer = ShadowRunServiceLive.pipe(
						Layer.provide(PrepareRunServiceLive),
						Layer.provide(
							Layer.mergeAll(
								rulesLayer,
								Layer.succeed(ReviewRunService, { run: runSpy }),
								Layer.succeed(EndpointProbeService, {
									probe: () => Effect.succeed({ status: 'online' }),
								})
							)
						)
					)
					const headRules = yield* RulesService.use(service =>
						service.load(headSha)
					).pipe(Effect.provide(rulesLayer))
					expect(headRules.config.skip.labels).toContain('storage')
					expect(
						yield* ShadowRunService.use(service =>
							service.run({ eventName: 'pull_request_target', readEvent })
						).pipe(Effect.provide(serviceLayer))
					).toMatchObject({
						status: 'reviewed',
						report: { planReport: { rulesSource: baseSha } },
					})
					expect(runSpy).toHaveBeenCalledOnce()
					const request = runSpy.mock.calls[0]?.[0]
					expect(request).toMatchObject({
						baseRef: baseSha,
						headRef: headSha,
						rules: { source: baseSha, config: { skip: { labels: [] } } },
					})
				})
		)
	}
)

layer(Layer.empty)('ShadowRunService prior runs', test => {
	test.effect(
		'at the limit skips before probing the endpoint or starting review',
		() =>
			Effect.gen(function* () {
				const fixture = harness()
				const readPriorSpy = vi.fn(() =>
					Effect.succeed({
						runs: fixture.rules.config.limits.max_runs_per_pr,
						head: 'earlier-head',
					})
				)
				expect(
					yield* fixture.run({
						eventName: 'pull_request_target',
						readEvent: Effect.succeed(JSON.stringify(eventPayload())),
						readPrior: readPriorSpy,
					})
				).toMatchObject({
					status: 'skipped',
				})
				expect(readPriorSpy).toHaveBeenCalledTimes(1)
				expect(fixture.probeSpy).not.toHaveBeenCalled()
				expect(fixture.runSpy).not.toHaveBeenCalled()
			})
	)
	test.effect(
		'ready_for_review runs at the limit and passes the earlier head for incremental input',
		() =>
			Effect.gen(function* () {
				const fixture = harness()
				expect(
					yield* fixture.run({
						eventName: 'pull_request_target',
						readEvent: Effect.succeed(
							JSON.stringify({ ...eventPayload(), action: 'ready_for_review' })
						),
						readPrior: () =>
							Effect.succeed({
								runs: fixture.rules.config.limits.max_runs_per_pr,
								head: 'earlier-head',
							}),
					})
				).toMatchObject({ status: 'reviewed' })
				expect(fixture.probeSpy).toHaveBeenCalledTimes(1)
				expect(fixture.runSpy).toHaveBeenCalledWith(
					expect.objectContaining({ since: 'earlier-head' })
				)
			})
	)
	for (const head of [undefined, 'earlier-head'])
		for (const trigger of ['auto', 'manual'] as const)
			test.effect(
				`only an automatic trigger with a reviewed head passes since, trigger=${trigger}, head=${head}`,
				() =>
					Effect.gen(function* () {
						const fixture = harness()
						const event = yield* eventParser.parsePullRequestEvent(
							JSON.stringify(eventPayload())
						)
						const parsePullRequestEventSpy = vi
							.spyOn(eventParser, 'parsePullRequestEvent')
							.mockReturnValueOnce(
								Effect.succeed({ ...event, pr: { ...event.pr, trigger } })
							)
						expect(
							yield* fixture.run({
								eventName: 'pull_request_target',
								readEvent: Effect.succeed(JSON.stringify(eventPayload())),
								readPrior: () =>
									Effect.succeed({
										runs: 1,
										...(head === undefined ? {} : { head }),
									}),
							})
						).toMatchObject({ status: 'reviewed' })
						expect(parsePullRequestEventSpy).toHaveBeenCalledTimes(1)
						const request = fixture.runSpy.mock.calls[0]?.[0]
						if (trigger === 'auto' && head !== undefined)
							expect(request).toHaveProperty('since', 'earlier-head')
						else expect(request).not.toHaveProperty('since')
					})
			)
})

describe('getRunLimitReason', () => {
	test.each([
		{
			runs: 2,
			limit: 3,
			trigger: 'auto',
			action: 'synchronize',
			limited: false,
		},
		{
			runs: 3,
			limit: 3,
			trigger: 'auto',
			action: 'synchronize',
			limited: true,
		},
		{
			runs: 4,
			limit: 3,
			trigger: 'auto',
			action: 'synchronize',
			limited: true,
		},
		{
			runs: 3,
			limit: 3,
			trigger: 'auto',
			action: 'ready_for_review',
			limited: false,
		},
		{
			runs: 3,
			limit: 3,
			trigger: 'manual',
			action: 'synchronize',
			limited: false,
		},
	] as const)(
		'$runs runs, limit=$limit, $trigger, $action',
		({ runs, limit, trigger, action, limited }) => {
			expect(
				getRunLimitReason({ runs, head: 'prior' }, limit, {
					action,
					pr: { labels: [], draft: false, fork: false, trigger },
				})
			).toBe(
				limited
					? `run limit reached: ${runs} of ${limit} runs on this pull request; a manual command still runs`
					: undefined
			)
		}
	)
	test('without a prior run no limit applies', () => {
		expect(
			getRunLimitReason(undefined, 0, {
				pr: { labels: [], draft: false, fork: false, trigger: 'auto' },
			})
		).toBeUndefined()
	})
})

layer(Layer.empty)('split prepare and review', test => {
	for (const stage of ['fork', 'gate', 'limit'] as const)
		test.effect(
			`prepare stops at ${stage} without endpoint or review calls`,
			() =>
				Effect.gen(function* () {
					const fixture = harness({
						config: {
							...DEFAULT_PRESET,
							skip: {
								...DEFAULT_PRESET.skip,
								labels: stage === 'gate' ? ['storage'] : [],
							},
						},
					})
					const payload = eventPayload()
					const readThreadsSpy = vi.fn(() => Effect.succeed([]))
					const readPriorSpy = vi.fn(() =>
						Effect.succeed({
							runs: fixture.rules.config.limits.max_runs_per_pr,
						})
					)
					expect(
						yield* fixture.prepare({
							eventName: 'pull_request_target',
							readEvent: Effect.succeed(
								JSON.stringify({
									...payload,
									pull_request: {
										...payload.pull_request,
										head: {
											...payload.pull_request.head,
											repo: {
												full_name:
													stage === 'fork'
														? 'example/fork'
														: payload.repository.full_name,
											},
										},
									},
								})
							),
							readPrior: readPriorSpy,
							readThreads: readThreadsSpy,
						})
					).toMatchObject({ status: 'skipped' })
					expect(fixture.probeSpy).not.toHaveBeenCalled()
					expect(fixture.runSpy).not.toHaveBeenCalled()
					expect(readThreadsSpy).not.toHaveBeenCalled()
					if (stage !== 'limit') expect(readPriorSpy).not.toHaveBeenCalled()
					if (stage === 'fork') expect(fixture.loadSpy).not.toHaveBeenCalled()
				})
		)
	for (const status of ['skipped', 'invalid-config', 'failed'] as const)
		test.effect(
			`review returns a prepared ${status} unchanged without probing`,
			() =>
				Effect.gen(function* () {
					const fixture = harness()
					const event = yield* eventParser.parsePullRequestEvent(
						JSON.stringify(eventPayload())
					)
					const prepared: PreparedRun =
						status === 'invalid-config'
							? {
									status,
									reason: 'prepared reason',
									event,
									source: '.mng/review.yml',
								}
							: { status, reason: 'prepared reason', event }
					expect(yield* fixture.review(prepared)).toBe(prepared)
					expect(fixture.loadSpy).not.toHaveBeenCalled()
					expect(fixture.probeSpy).not.toHaveBeenCalled()
					expect(fixture.runSpy).not.toHaveBeenCalled()
				})
		)
	for (const trigger of ['auto', 'manual'] as const)
		test.effect(
			`review uses prior head only for ${trigger} automatic input`,
			() =>
				Effect.gen(function* () {
					const fixture = harness()
					const event = yield* eventParser.parsePullRequestEvent(
						JSON.stringify(eventPayload())
					)
					expect(
						yield* fixture.review({
							status: 'ready',
							event: { ...event, pr: { ...event.pr, trigger } },
							threads: [],
							prior: { runs: 1, head: 'earlier-head' },
						})
					).toMatchObject({ status: 'reviewed' })
					expect(fixture.loadSpy).toHaveBeenCalledExactlyOnceWith(BASE_SHA)
					const request = fixture.runSpy.mock.calls[0]?.[0]
					if (trigger === 'auto')
						expect(request).toHaveProperty('since', 'earlier-head')
					else expect(request).not.toHaveProperty('since')
				})
		)
	test.effect('prepare followed by review reuses in-memory rules', () =>
		Effect.gen(function* () {
			const fixture = harness()
			const prepared = yield* fixture.prepare()
			expect(prepared.status).toBe('ready')
			expect(fixture.probeSpy).not.toHaveBeenCalled()
			expect(yield* fixture.review(prepared)).toMatchObject({
				status: 'reviewed',
			})
			expect(fixture.loadSpy).toHaveBeenCalledExactlyOnceWith(BASE_SHA)
		})
	)
})
