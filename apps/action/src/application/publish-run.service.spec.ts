import { layer } from '@effect/vitest'
import { ConfigError, type KeptFinding } from '@mng-review/domain'
import { RulesService, type Rules } from '@mng-review/engine'
import {
	GITHUB_ACTIONS_IDENTITY,
	GitHubConfig,
	PublishService,
	GitHubApiError,
	StatusReportService,
	MARKER_VERSION,
	SummaryCommentService,
	type SummaryMarker,
} from '@mng-review/github'
import { Effect, Layer, Redacted } from 'effect'
import { parseOutcomeFile } from '../infrastructure/outcome-file.parser'
import type {
	OutcomeBinding,
	OutcomeFile,
} from '../infrastructure/outcome-file.schema'
import {
	boundReviewReport,
	outcomeFile as boundOutcomeFile,
} from '../shared/mocks/outcome-file.helper'
import { reviewReport, RULES } from '../shared/mocks/review-report.helper'
import {
	PublishRunService,
	PublishRunServiceLive,
	type PublishContext,
} from './publish-run.service'
import { FORK_REASON } from './run-gate.helper'
import type { PullRequestEvent } from './shadow-run.types'

const EVENT = {
	number: 17,
	baseSha: 'base',
	headSha: 'head',
	pr: { labels: [], draft: false, fork: false, trigger: 'auto' },
} as const satisfies PullRequestEvent
const CONTEXT = {
	engineCommit: 'engine',
	pullNumber: EVENT.number,
	head: EVENT.headSha,
	event: EVENT,
} as const satisfies PublishContext
const BINDING = {
	repository: 'example/project',
	runId: '1',
	runAttempt: '1',
	engineCommit: null,
	pullNumber: EVENT.number,
	baseSha: EVENT.baseSha,
	headSha: EVENT.headSha,
} as const satisfies OutcomeBinding

/** An outcome file bound to the fixture's pull request. */
function outcomeFile(
	fields: Omit<OutcomeFile, 'version' | 'binding'>
): OutcomeFile {
	return { version: 1, binding: BINDING, ...fields }
}
const PUBLISHED = {
	verdict: 'needs fixes',
	openBugs: 1,
	onLine: 1,
	onFile: 0,
	inSummary: 0,
	unposted: 0,
	repeated: 0,
	dismissed: 0,
	rechecked: 0,
	resolved: 0,
	run: 1,
	cleanup: 'none',
} as const

/** Publisher test layer records which outcome path is taken and can fail either write. */
function setup(
	fail = false,
	rulesError?: ConfigError,
	rules: Rules = RULES,
	prior?: SummaryMarker,
	readPriorError?: GitHubApiError
) {
	const readPriorSpy = vi.fn(() =>
		readPriorError ? Effect.fail(readPriorError) : Effect.succeed(prior)
	)
	const publishSpy = vi.fn(() =>
		fail
			? Effect.fail(
					new GitHubApiError({
						operation: 'publish',
						reason: 'offline',
						status: 503,
					})
				)
			: Effect.succeed(PUBLISHED)
	)
	const publishStatusSpy = vi.fn(() =>
		fail
			? Effect.fail(
					new GitHubApiError({ operation: 'status', reason: 'offline' })
				)
			: Effect.succeed(true)
	)
	const reportSpy = vi.fn(() => Effect.succeed({ checks: 1, status: true }))
	const reportOfflineSpy = vi.fn(() => Effect.succeed(true))
	const loadSpy = vi.fn(() =>
		rulesError ? Effect.fail(rulesError) : Effect.succeed(rules)
	)
	const service = PublishRunServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(RulesService, { load: loadSpy }),
				Layer.succeed(StatusReportService, {
					report: reportSpy,
					reportOffline: reportOfflineSpy,
				}),
				Layer.succeed(PublishService, {
					readThreads: () => Effect.succeed([]),
					publish: publishSpy,
				}),
				Layer.succeed(SummaryCommentService, {
					read: () => Effect.succeed(undefined),
					write: () => Effect.die('the run never writes the summary itself'),
					readPrior: readPriorSpy,
					publishStatus: publishStatusSpy,
				}),
				Layer.succeed(GitHubConfig, {
					serverUrl: 'https://github.com',
					apiUrl: 'https://api.github.com',
					graphqlUrl: 'https://api.github.com/graphql',
					owner: 'example',
					name: 'project',
					token: Redacted.make('fixture'),
					identity: GITHUB_ACTIONS_IDENTITY,
				})
			)
		)
	)
	return {
		service,
		loadSpy,
		readPriorSpy,
		publishSpy,
		publishStatusSpy,
		reportSpy,
		reportOfflineSpy,
	}
}

layer(Layer.empty)('PublishRunService', test => {
	test.effect('passes report, base rules and target to publishing', () =>
		Effect.gen(function* () {
			const fixture = setup()
			const service = yield* PublishRunService.pipe(
				Effect.provide(fixture.service)
			)
			const report = reviewReport()
			const placed = {
				...report,
				nits: report.nits.map(nit => ({
					...nit,
					placement: 'inline' as const,
				})),
			}
			expect(
				yield* service.run(outcomeFile({ status: 'reviewed', report }), CONTEXT)
			).toEqual({
				status: 'published',
				result: PUBLISHED,
				checks: { checks: 1, status: true },
			})
			expect(fixture.publishSpy).toHaveBeenCalledExactlyOnceWith({
				pullNumber: EVENT.number,
				report: placed,
				rules: RULES,
				head: EVENT.headSha,
				engineCommit: CONTEXT.engineCommit,
			})
			expect(fixture.loadSpy).toHaveBeenCalledExactlyOnceWith(EVENT.baseSha)
			expect(fixture.readPriorSpy).toHaveBeenCalledExactlyOnceWith(EVENT.number)
			expect(fixture.publishStatusSpy).not.toHaveBeenCalled()
			expect(fixture.reportSpy).toHaveBeenCalledExactlyOnceWith({
				head: EVENT.headSha,
				report: placed,
				verdict: PUBLISHED.verdict,
				openBugs: PUBLISHED.openBugs,
			})
			expect(fixture.reportOfflineSpy).not.toHaveBeenCalled()
		})
	)
	test.effect(
		'offline publishes its summary and reports an offline status',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const service = yield* PublishRunService.pipe(
					Effect.provide(fixture.service)
				)
				expect(
					yield* service.run(
						outcomeFile({ status: 'offline', reason: 'no endpoint' }),
						CONTEXT
					)
				).toEqual({
					status: 'status-only',
					reason: 'Reviewer offline: no endpoint. Nothing was reviewed.',
					posted: true,
				})
				expect(fixture.publishSpy).not.toHaveBeenCalled()
				expect(fixture.reportOfflineSpy).toHaveBeenCalledExactlyOnceWith(
					EVENT.headSha
				)
				expect(fixture.reportSpy).not.toHaveBeenCalled()
				expect(fixture.publishStatusSpy).toHaveBeenCalledExactlyOnceWith({
					pullNumber: EVENT.number,
					head: EVENT.headSha,
					engineCommit: CONTEXT.engineCommit,
					status: 'Reviewer offline: no endpoint. Nothing was reviewed.',
				})
			})
	)
	for (const status of ['reviewed', 'offline'] as const)
		test.effect(
			`${status} GitHub failure becomes a failed report without failing the effect`,
			() =>
				Effect.gen(function* () {
					const fixture = setup(true)
					const service = yield* PublishRunService.pipe(
						Effect.provide(fixture.service)
					)
					const outcome =
						status === 'reviewed'
							? outcomeFile({ status, report: reviewReport() })
							: outcomeFile({ status, reason: 'offline' })
					const published = yield* service.run(outcome, CONTEXT)
					expect(published.status).toBe('failed')
					if (published.status === 'failed')
						expect(published.reason).toContain('offline')
				})
		)
	for (const outcome of [
		outcomeFile({ status: 'skipped', reason: 'skip' }),
		outcomeFile({
			status: 'invalid-config',
			source: '.mng/review.yml',
			reason: 'invalid',
		}),
		outcomeFile({ status: 'failed', reason: 'git failure' }),
	])
		test.effect(`${outcome.status} writes nothing`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				const service = yield* PublishRunService.pipe(
					Effect.provide(fixture.service)
				)
				expect(yield* service.run(outcome, CONTEXT)).toMatchObject({
					status: 'not-published',
				})
				expect(fixture.publishSpy).not.toHaveBeenCalled()
				expect(fixture.publishStatusSpy).not.toHaveBeenCalled()
			})
		)
	for (const skippedRun of [undefined, 'skip rule'])
		test.effect(
			`empty review plan publishes unless gated by ${skippedRun}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const service = yield* PublishRunService.pipe(
						Effect.provide(fixture.service)
					)
					const report = reviewReport()
					const reviewed = {
						...report,
						planReport: {
							...report.planReport,
							plan: {
								...report.planReport.plan,
								runs: [],
								...(skippedRun ? { skippedRun } : {}),
							},
						},
					}

					expect(
						yield* service.run(
							outcomeFile({ status: 'reviewed', report: reviewed }),
							CONTEXT
						)
					).toMatchObject({
						status: skippedRun ? 'not-published' : 'published',
						...(skippedRun
							? { reason: skippedRun }
							: { result: PUBLISHED, checks: { checks: 1, status: true } }),
					})
					if (skippedRun) {
						expect(fixture.publishSpy).not.toHaveBeenCalled()
						expect(fixture.reportSpy).not.toHaveBeenCalled()
					} else {
						expect(fixture.publishSpy).toHaveBeenCalledOnce()
						expect(fixture.reportSpy).toHaveBeenCalledExactlyOnceWith({
							head: EVENT.headSha,
							report: {
								...reviewed,
								nits: reviewed.nits.map(nit => ({
									...nit,
									placement: 'inline',
								})),
							},
							verdict: PUBLISHED.verdict,
							openBugs: PUBLISHED.openBugs,
						})
					}
				})
		)
})

interface BugPlacementCase {
	readonly name: string
	readonly finding: Partial<KeptFinding>
	readonly placement: KeptFinding['placement']
	readonly blocking: boolean
}

layer(Layer.empty)('PublishRunService decoded outcomes', test => {
	test.effect(
		'a file cannot place nits inline when the loaded max_nits is zero',
		() =>
			Effect.gen(function* () {
				const rules = {
					...RULES,
					config: {
						...RULES.config,
						comments: { ...RULES.config.comments, max_nits: 0 },
					},
				}
				const fixture = setup(false, undefined, rules)
				const report = boundReviewReport()
				const nits = report.nits.map(nit => ({
					...nit,
					placement: 'inline' as const,
				}))
				const decoded = yield* parseOutcomeFile(
					JSON.stringify({
						...boundOutcomeFile(),
						report: { ...report, bugs: [], nits, blocking: true },
					})
				)
				yield* PublishRunService.use(service =>
					service.run(decoded, CONTEXT)
				).pipe(Effect.provide(fixture.service))
				const placed = {
					...report,
					bugs: [],
					nits: nits.map(nit => ({ ...nit, placement: 'summary' as const })),
					blocking: false,
				}
				expect(fixture.publishSpy).toHaveBeenCalledExactlyOnceWith({
					engineCommit: CONTEXT.engineCommit,
					pullNumber: CONTEXT.pullNumber,
					head: CONTEXT.head,
					report: placed,
					rules,
				})
				expect(fixture.reportSpy).toHaveBeenCalledExactlyOnceWith({
					head: CONTEXT.head,
					report: placed,
					verdict: PUBLISHED.verdict,
					openBugs: PUBLISHED.openBugs,
				})
			})
	)
	for (const { name, finding, placement, blocking } of [
		{
			name: 'a low bug marked inline under a critical floor stays in the summary and does not block',
			finding: { severity: 'low', placement: 'inline' },
			placement: 'summary',
			blocking: false,
		},
		{
			name: 'an unverified bug marked inline stays out of blocking threads even at the floor',
			finding: {
				severity: 'critical',
				placement: 'inline',
				validation: {
					status: 'unverified',
					severity: 'critical',
					premise: 'The caller retries.',
					reason: 'The retry repeats the write.',
					evidence: [],
					model: 'model-a',
				},
			},
			placement: 'summary',
			blocking: false,
		},
		{
			name: 'a bug hidden in the summary at the floor becomes inline and blocks despite the file flag',
			finding: { severity: 'critical', placement: 'summary' },
			placement: 'inline',
			blocking: true,
		},
	] as const satisfies readonly BugPlacementCase[])
		test.effect(name, () =>
			Effect.gen(function* () {
				const rules = {
					...RULES,
					config: {
						...RULES.config,
						comments: {
							...RULES.config.comments,
							min_severity: 'critical' as const,
						},
					},
				}
				const fixture = setup(false, undefined, rules)
				const report = boundReviewReport()
				const bugs = report.bugs.map(bug => ({ ...bug, ...finding }))
				const decoded = yield* parseOutcomeFile(
					JSON.stringify({
						...boundOutcomeFile(),
						report: { ...report, bugs, nits: [], blocking: !blocking },
					})
				)
				yield* PublishRunService.use(service =>
					service.run(decoded, CONTEXT)
				).pipe(Effect.provide(fixture.service))
				const placed = {
					...report,
					bugs: bugs.map(bug => ({ ...bug, placement })),
					nits: [],
					blocking,
				}
				expect(fixture.publishSpy).toHaveBeenCalledExactlyOnceWith({
					engineCommit: CONTEXT.engineCommit,
					pullNumber: CONTEXT.pullNumber,
					head: CONTEXT.head,
					report: placed,
					rules,
				})
				expect(fixture.reportSpy).toHaveBeenCalledExactlyOnceWith({
					head: CONTEXT.head,
					report: placed,
					verdict: PUBLISHED.verdict,
					openBugs: PUBLISHED.openBugs,
				})
			})
		)
	test.effect(
		'publishes the decoded report with proposals and freshly loaded rules without a model layer',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const file = boundOutcomeFile()
				const recheck = {
					checked: 1,
					rejected: [
						{
							threadId: 'thread',
							fingerprint: 'fingerprint',
							reason: 'The write is guarded.',
						},
					],
					tokens: {
						validator: {
							calls: 1,
							inputTokens: 3,
							cachedInputTokens: 0,
							outputTokens: 2,
							reasoningTokens: 0,
							totalTokens: 5,
						},
					},
				} as const
				const decoded = yield* parseOutcomeFile(
					JSON.stringify({
						...file,
						recheck,
						rules: { config: { skip: true } },
					})
				)
				const context = {
					engineCommit: file.binding.engineCommit ?? undefined,
					pullNumber: file.binding.pullNumber,
					head: file.binding.headSha,
					event: EVENT,
				}
				expect(
					yield* PublishRunService.use(service =>
						service.run(decoded, context)
					).pipe(Effect.provide(fixture.service))
				).toEqual({
					status: 'published',
					result: PUBLISHED,
					checks: { checks: 1, status: true },
				})
				expect(fixture.loadSpy).toHaveBeenCalledExactlyOnceWith(
					file.binding.baseSha
				)
				expect(fixture.publishSpy).toHaveBeenCalledExactlyOnceWith({
					engineCommit: context.engineCommit,
					pullNumber: context.pullNumber,
					head: context.head,
					report: {
						...boundReviewReport(),
						nits: boundReviewReport().nits.map(nit => ({
							...nit,
							placement: 'inline',
						})),
					},
					rules: RULES,
					recheck: {
						checked: recheck.checked,
						proposals: recheck.rejected,
						tokens: recheck.tokens,
					},
				})
			})
	)
	test.effect(
		'a rules load failure publishes nothing and reports the source',
		() =>
			Effect.gen(function* () {
				const fixture = setup(
					false,
					new ConfigError({
						source: '.mng/review.yml',
						reason: 'Invalid rules.',
					})
				)
				expect(
					yield* PublishRunService.use(service =>
						service.run(boundOutcomeFile(), CONTEXT)
					).pipe(Effect.provide(fixture.service))
				).toEqual({
					status: 'failed',
					reason:
						'the rules at the base commit: .mng/review.yml: Invalid rules.',
				})
				expect(fixture.publishSpy).not.toHaveBeenCalled()
				expect(fixture.publishStatusSpy).not.toHaveBeenCalled()
				expect(fixture.reportSpy).not.toHaveBeenCalled()
				expect(fixture.reportOfflineSpy).not.toHaveBeenCalled()
			})
	)
})

layer(Layer.empty)('PublishRunService independent run gates', test => {
	for (const status of ['offline', 'reviewed'] as const) {
		for (const gate of ['draft', 'skip label', 'fork', 'run limit'] as const)
			test.effect(`${status} for a ${gate} writes nothing`, () =>
				Effect.gen(function* () {
					const rules = {
						...RULES,
						config: {
							...RULES.config,
							skip: { ...RULES.config.skip, labels: ['skip-review'] },
						},
					}
					const runs = rules.config.limits.max_runs_per_pr
					const fixture = setup(
						false,
						undefined,
						rules,
						gate === 'run limit'
							? { v: MARKER_VERSION, runs, head: 'previous-head' }
							: undefined
					)
					const event = {
						...EVENT,
						pr: {
							...EVENT.pr,
							draft: gate === 'draft',
							fork: gate === 'fork',
							labels: gate === 'skip label' ? ['skip-review'] : [],
						},
					}
					const outcome = outcomeFile(
						status === 'reviewed'
							? { status, report: reviewReport() }
							: { status, reason: 'no endpoint' }
					)
					expect(
						yield* PublishRunService.use(service =>
							service.run(outcome, { ...CONTEXT, event })
						).pipe(Effect.provide(fixture.service))
					).toEqual({
						status: 'not-published',
						reason:
							gate === 'draft'
								? 'draft pull request (skip.drafts)'
								: gate === 'skip label'
									? 'label skip-review is in skip.labels'
									: gate === 'fork'
										? FORK_REASON
										: `run limit reached: ${runs} of ${runs} runs on this pull request; a manual command still runs`,
					})
					expect(fixture.loadSpy).toHaveBeenCalledExactlyOnceWith(
						BINDING.baseSha
					)
					expect(fixture.readPriorSpy).toHaveBeenCalledExactlyOnceWith(
						CONTEXT.pullNumber
					)
					expect(fixture.publishSpy).not.toHaveBeenCalled()
					expect(fixture.publishStatusSpy).not.toHaveBeenCalled()
					expect(fixture.reportSpy).not.toHaveBeenCalled()
					expect(fixture.reportOfflineSpy).not.toHaveBeenCalled()
				})
			)
		test.effect(`${status} with a failed prior read fails without writes`, () =>
			Effect.gen(function* () {
				const error = new GitHubApiError({
					operation: 'readPrior',
					reason: 'summary unavailable',
					status: 503,
				})
				const fixture = setup(false, undefined, RULES, undefined, error)
				const outcome = outcomeFile(
					status === 'reviewed'
						? { status, report: reviewReport() }
						: { status, reason: 'no endpoint' }
				)
				expect(
					yield* PublishRunService.use(service =>
						service.run(outcome, CONTEXT)
					).pipe(Effect.provide(fixture.service))
				).toEqual({ status: 'failed', reason: error.message })
				expect(fixture.readPriorSpy).toHaveBeenCalledExactlyOnceWith(
					CONTEXT.pullNumber
				)
				expect(fixture.publishSpy).not.toHaveBeenCalled()
				expect(fixture.publishStatusSpy).not.toHaveBeenCalled()
				expect(fixture.reportSpy).not.toHaveBeenCalled()
				expect(fixture.reportOfflineSpy).not.toHaveBeenCalled()
			})
		)
	}
})
