import { layer } from '@effect/vitest'
import { ConfigError, type KeptFinding } from '@mng-review/domain'
import { RulesService, type Rules } from '@mng-review/engine'
import {
	GITHUB_ACTIONS_IDENTITY,
	GitHubApiError,
	GitHubConfig,
	ListCompleteness,
	toBotIdentity,
	toAnswerEntry,
	MARKER_VERSION,
	PublishIncompleteError,
	PublishService,
	ReplyPublishService,
	StatusReportService,
	SummaryReviewService,
	type SummaryMarker,
} from '@mng-review/github'
import { Effect, FileSystem, Layer, Redacted } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The brief requires shared risk boundary fixtures.
import {
	riskFixture,
	RISK_RULES,
	RISK_HEAD,
	RISK_BASE,
	LOW_RATING,
} from '../../../../packages/github/src/shared/mocks/github-status-fake.helper'
// oxlint-disable-next-line no-restricted-imports -- The brief requires shared app identity fixtures.
import { APP_IDENTITY } from '../../../../packages/github/src/shared/mocks/publish-test.helper'
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
import { RiskRunOffLayer } from '../shared/mocks/risk-run.helper'
import {
	PublishRunService,
	PublishRunServiceLive,
	type PublishContext,
} from './publish-run.service'
import { RiskRunService, RiskRunServiceLive } from './risk-run.service'
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
	trigger: 'push',
} as const satisfies OutcomeBinding

/** An outcome file bound to the fixture's pull request. */
function outcomeFile(
	fields: Omit<OutcomeFile, 'version' | 'binding'>
): OutcomeFile {
	return { version: 1, binding: BINDING, ...fields }
}
const DISMISSED_ONE = { dismissed: 1, failed: 0 } as const
const OFFLINE_WRITTEN = {
	body: '',
	marker: { v: 1, runs: 0 },
	event: 'COMMENT',
	cleanup: 'none',
	created: true,
	inline: true,
	dismissal: DISMISSED_ONE,
} as const
const PUBLISHED = {
	verdict: 'needs fixes',
	event: 'REQUEST_CHANGES',
	dismissal: { dismissed: 0, failed: 0 },
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
	finished: true,
	answered: {},
	waiting: 0,
	label: 'none',
	cleanup: 'none',
	unsettled: 0,
} as const

/** Publisher test layer records which outcome path is taken and can fail either write. */
function setup(
	fail = false,
	rulesError?: ConfigError,
	rules: Rules = RULES,
	prior?: SummaryMarker,
	readPriorError?: GitHubApiError,
	riskLayer: Layer.Layer<RiskRunService> = RiskRunOffLayer,
	identity = GITHUB_ACTIONS_IDENTITY,
	replyPublish: ReplyPublishService['Service']['publish'] = () =>
		Effect.die('a push or command run never answers alone')
) {
	const readPriorSpy = vi.fn(() =>
		readPriorError ? Effect.fail(readPriorError) : Effect.succeed(prior)
	)
	const publishSpy = vi.fn<PublishService['Service']['publish']>(() =>
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
	const publishStatusSpy = vi.fn<
		SummaryReviewService['Service']['publishStatus']
	>(() =>
		fail
			? Effect.fail(
					new GitHubApiError({ operation: 'status', reason: 'offline' })
				)
			: Effect.succeed(OFFLINE_WRITTEN)
	)
	const reportSpy = vi.fn(() => Effect.succeed({ checks: 1, status: true }))
	const reportOfflineSpy = vi.fn(() => Effect.succeed(true))
	const reportUnfinishedSpy = vi.fn<
		StatusReportService['Service']['reportUnfinished']
	>(() => Effect.succeed(true))
	const loadSpy = vi.fn(() =>
		rulesError ? Effect.fail(rulesError) : Effect.succeed(rules)
	)
	const service = PublishRunServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				riskLayer,
				Layer.succeed(RulesService, { load: loadSpy }),
				Layer.succeed(StatusReportService, {
					report: reportSpy,
					setVerdictStatus: () =>
						Effect.die('the run sets the status through report'),
					setIncompleteMarkerStatus: () =>
						Effect.die('the run sets the status through report'),
					reportOffline: reportOfflineSpy,
					reportUnfinished: reportUnfinishedSpy,
				}),
				Layer.succeed(PublishService, {
					readThreads: () => Effect.succeed([]),
					publish: publishSpy,
				}),
				Layer.succeed(ReplyPublishService, { publish: replyPublish }),
				Layer.succeed(SummaryReviewService, {
					write: () => Effect.die('the run never writes the summary itself'),
					readPrior: readPriorSpy,
					publishStatus: publishStatusSpy,
					readWaiting: () => Effect.die('the run never reads the waiting list'),
					reserveManualRun: () =>
						Effect.die('the run never reserves a manual run'),
				}),
				Layer.succeed(GitHubConfig, {
					serverUrl: 'https://github.com',
					apiUrl: 'https://api.github.com',
					graphqlUrl: 'https://api.github.com/graphql',
					owner: 'example',
					name: 'project',
					token: Redacted.make('fixture'),
					identity,
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
		reportUnfinishedSpy,
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
				finished: PUBLISHED.finished,
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
					dismissal: DISMISSED_ONE,
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
	for (const written of [true, false])
		test.effect(
			`an incomplete publish preserves its original failure when the unfinished status returns ${written}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const error = new GitHubApiError({
						operation: 'updateIssueComment',
						reason: 'summary update refused',
						status: 503,
					})
					fixture.publishSpy.mockReturnValue(
						Effect.fail(new PublishIncompleteError({ error }))
					)
					fixture.reportUnfinishedSpy.mockReturnValue(Effect.succeed(written))
					expect(
						yield* PublishRunService.use(service =>
							service.run(
								outcomeFile({ status: 'reviewed', report: reviewReport() }),
								CONTEXT
							)
						).pipe(Effect.provide(fixture.service))
					).toEqual({ status: 'failed', reason: error.message })
					expect(fixture.publishSpy).toHaveBeenCalledTimes(1)
					expect(fixture.reportUnfinishedSpy).toHaveBeenCalledExactlyOnceWith(
						CONTEXT.head
					)
					expect(fixture.reportSpy).not.toHaveBeenCalled()
					expect(fixture.reportOfflineSpy).not.toHaveBeenCalled()
					expect(fixture.publishStatusSpy).not.toHaveBeenCalled()
				})
		)
	test.effect(
		'a plain publish API error does not report an unfinished status',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const error = new GitHubApiError({
					operation: 'listReviewThreads',
					reason: 'thread read refused',
					status: 503,
				})
				fixture.publishSpy.mockReturnValue(Effect.fail(error))
				expect(
					yield* PublishRunService.use(service =>
						service.run(
							outcomeFile({ status: 'reviewed', report: reviewReport() }),
							CONTEXT
						)
					).pipe(Effect.provide(fixture.service))
				).toEqual({ status: 'failed', reason: error.message })
				expect(fixture.publishSpy).toHaveBeenCalledTimes(1)
				expect(fixture.reportUnfinishedSpy).not.toHaveBeenCalled()
				expect(fixture.reportSpy).not.toHaveBeenCalled()
				expect(fixture.reportOfflineSpy).not.toHaveBeenCalled()
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
							finished: PUBLISHED.finished,
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
					finished: PUBLISHED.finished,
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
					finished: PUBLISHED.finished,
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

layer(Layer.empty)('PublishRunService dismissal outcomes', test => {
	test.effect(
		'preserves failed dismissals from a published review in the result',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.publishSpy.mockReturnValueOnce(
					Effect.succeed({
						...PUBLISHED,
						dismissal: { dismissed: 1, failed: 2 },
					})
				)
				expect(
					yield* PublishRunService.use(service =>
						service.run(
							outcomeFile({ status: 'reviewed', report: reviewReport() }),
							CONTEXT
						)
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({
					status: 'published',
					result: { dismissal: { dismissed: 1, failed: 2 } },
				})
			})
	)
	for (const created of [false, true])
		test.effect(
			`preserves failed dismissals from an offline summary with created=${created}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.publishStatusSpy.mockReturnValueOnce(
						Effect.succeed({
							...OFFLINE_WRITTEN,
							created,
							dismissal: { dismissed: 1, failed: 2 },
						})
					)
					expect(
						yield* PublishRunService.use(service =>
							service.run(
								outcomeFile({ status: 'offline', reason: 'unavailable' }),
								CONTEXT
							)
						).pipe(Effect.provide(fixture.service))
					).toMatchObject({
						status: 'status-only',
						posted: created,
						dismissal: { dismissed: 1, failed: 2 },
					})
				})
		)
})

layer(Layer.empty)('PublishRunService risk answer wiring', test => {
	for (const kind of [
		'push',
		'review command',
		'agent command',
		'unknown start',
	] as const)
		test.effect(
			`${kind} reads the commands it answers and passes the entry to publishing`,
			() =>
				Effect.gen(function* () {
					const entry = toAnswerEntry(
						7,
						kind === 'agent command' ? 'run' : 'review',
						[{ id: 42, at: '2026-01-01T12:00:00Z', body: 'command' }],
						kind === 'agent command' ? 'auth' : undefined
					)
					const readAnswersSpy = vi.fn<
						RiskRunService['Service']['readAnswers']
					>(() => Effect.succeed(entry ? [entry] : []))
					const riskLayer = Layer.succeed(RiskRunService, {
						readAnswers: readAnswersSpy,
						rateFull: (_gate, _input, publish) =>
							publish(undefined).pipe(
								Effect.map(value => ({
									value,
									risk: { status: 'none' } as const,
								}))
							),
						rateThread: () => Effect.succeed({ status: 'none' } as const),
					})
					const rules = {
						...RULES,
						config: {
							...RULES.config,
							risk: { ...RULES.config.risk, enabled: true },
						},
					}
					const fixture = setup(
						false,
						undefined,
						rules,
						undefined,
						undefined,
						riskLayer,
						toBotIdentity('mng-review')
					)
					const context = {
						...CONTEXT,
						run: 7,
						risk: { environment: 'review', defaultBranch: 'main' },
						event: {
							...EVENT,
							pr: {
								...EVENT.pr,
								target: 'main',
								...(kind === 'push' ? {} : { trigger: 'manual' as const }),
							},
						},
						...(kind === 'agent command'
							? { command: { agentOnly: true, agent: 'auth' } }
							: kind === 'review command'
								? { command: { agentOnly: false } }
								: {}),
					}
					yield* PublishRunService.use(service =>
						service.run(
							outcomeFile({
								status: 'reviewed',
								report: reviewReport(),
								...(kind === 'unknown start'
									? {}
									: { startedAt: '2026-01-01T12:30:00Z' }),
							}),
							context
						)
					).pipe(Effect.provide(fixture.service))
					if (kind === 'unknown start') {
						expect(readAnswersSpy).not.toHaveBeenCalled()
						expect(fixture.publishSpy.mock.calls[0]?.[0]).not.toHaveProperty(
							'answers'
						)
						return
					}
					expect(readAnswersSpy).toHaveBeenCalledWith(
						{ status: 'on' },
						{
							pullNumber: 17,
							run: 7,
							kind: kind === 'agent command' ? 'run' : 'review',
							before: '2026-01-01T12:30:00Z',
							...(kind === 'agent command' ? { agent: 'auth' } : {}),
						}
					)
					expect(fixture.publishSpy).toHaveBeenCalledWith(
						expect.objectContaining({ answers: [entry], run: 7 })
					)
				})
		)
})

layer(Layer.empty)('PublishRunService risk integration', test => {
	for (const failHeld of [true, false])
		test.effect(
			`full publish integrates the real risk run with held failure=${failHeld}`,
			() =>
				Effect.gen(function* () {
					const fake = riskFixture()
					if (failHeld)
						fake.failures.timeline.push(
							new GitHubApiError({ operation: 'held', reason: 'unavailable' })
						)
					const riskLayer = RiskRunServiceLive.pipe(
						Layer.provide(fake.services),
						Layer.provide(FileSystem.layerNoop({}))
					)
					const fixture = setup(
						false,
						undefined,
						RISK_RULES,
						undefined,
						undefined,
						riskLayer,
						APP_IDENTITY
					)
					const context = {
						...CONTEXT,
						head: RISK_HEAD,
						risk: { environment: 'review-app', defaultBranch: 'main' },
						event: {
							...EVENT,
							pr: { ...EVENT.pr, author: 'author-a', target: 'main' },
						},
					}
					const outcome = outcomeFile({
						status: 'reviewed',
						report: { ...reviewReport(), bugs: [], rating: LOW_RATING },
					})
					const published = yield* PublishRunService.use(service =>
						service.run(
							{
								...outcome,
								binding: {
									...outcome.binding,
									baseSha: RISK_BASE,
									headSha: RISK_HEAD,
								},
							},
							context
						)
					).pipe(Effect.provide(fixture.service))
					expect(published).toMatchObject(
						failHeld
							? { status: 'failed', risk: { status: 'failed' } }
							: {
									status: 'published',
									risk: {
										status: 'written',
										result: { state: 'success', level: 'low' },
									},
								}
					)
					if (failHeld) {
						expect(fixture.publishSpy).not.toHaveBeenCalled()
						expect(fixture.reportSpy).not.toHaveBeenCalled()
						expect(fake.writes).toEqual([])
						expect(fake.api.writes).toEqual([])
						return
					}
					expect(fixture.publishSpy.mock.calls[0]?.[0].rating).toMatchObject({
						status: 'rated',
						level: 'low',
					})
					expect(fake.writes.map(write => write.state)).toEqual([
						'error',
						'success',
					])
				})
		)
	test.effect(
		'the risk grant is the last GitHub write, after the normal checks and status report',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const riskLayer = RiskRunServiceLive.pipe(
					Layer.provide(fake.services),
					Layer.provide(FileSystem.layerNoop({}))
				)
				const fixture = setup(
					false,
					undefined,
					RISK_RULES,
					undefined,
					undefined,
					riskLayer,
					APP_IDENTITY
				)
				const riskWritesAtChecks: number[] = []
				fixture.reportSpy.mockImplementation(() =>
					Effect.sync(() => {
						riskWritesAtChecks.push(fake.writes.length)
						return { checks: 1, status: true }
					})
				)
				const outcome = outcomeFile({
					status: 'reviewed',
					report: { ...reviewReport(), bugs: [], rating: LOW_RATING },
				})
				yield* PublishRunService.use(service =>
					service.run(
						{
							...outcome,
							binding: {
								...outcome.binding,
								baseSha: RISK_BASE,
								headSha: RISK_HEAD,
							},
						},
						{
							...CONTEXT,
							head: RISK_HEAD,
							risk: { environment: 'review-app', defaultBranch: 'main' },
							event: {
								...EVENT,
								pr: { ...EVENT.pr, author: 'author-a', target: 'main' },
							},
						}
					)
				).pipe(Effect.provide(fixture.service))
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'success',
				])
				expect(riskWritesAtChecks).toEqual([1])
			})
	)
})

/** A rating gate that is on: the app, its environment and a pull request into the default branch. */
const RATED_CONTEXT = {
	...CONTEXT,
	risk: { environment: 'review-app', defaultBranch: 'main' },
	event: { ...EVENT, pr: { ...EVENT.pr, target: 'main' } },
} as const satisfies PublishContext
/** A recorded thread raise that writes nothing and a full rating that publishes unrated. */
function riskSpyLayer() {
	const rateThreadSpy = vi.fn<RiskRunService['Service']['rateThread']>(() =>
		Effect.succeed({ status: 'none' } as const)
	)
	const spyLayer = Layer.succeed(RiskRunService, {
		rateFull: (_gate, _input, publish) =>
			publish(undefined).pipe(
				Effect.map(value => ({ value, risk: { status: 'none' } as const }))
			),
		rateThread: rateThreadSpy,
		readAnswers: () => Effect.succeed([]),
	})
	return { spyLayer, rateThreadSpy }
}
const UNAVAILABLE = new GitHubApiError({
	operation: 'publish',
	reason: 'unavailable',
	status: 503,
})
/** A rated context on the risk fixture's head, for the real risk run. */
const LIVE_RATED_CONTEXT = {
	...RATED_CONTEXT,
	head: RISK_HEAD,
	event: { ...EVENT, pr: { ...EVENT.pr, author: 'author-a', target: 'main' } },
} as const satisfies PublishContext

/** The real risk run over the in-memory risk boundary, with the app identity and risk rules. */
function liveRiskSetup() {
	const fake = riskFixture()
	const riskLayer = RiskRunServiceLive.pipe(
		Layer.provide(fake.services),
		Layer.provide(FileSystem.layerNoop({}))
	)
	const fixture = setup(
		false,
		undefined,
		RISK_RULES,
		undefined,
		undefined,
		riskLayer,
		APP_IDENTITY
	)
	return { fake, fixture }
}

/** A reviewed Low outcome bound to the risk fixture's base and head. */
function liveRiskOutcome(): OutcomeFile {
	const outcome = outcomeFile({
		status: 'reviewed',
		report: { ...reviewReport(), bugs: [], rating: LOW_RATING },
	})
	return {
		...outcome,
		binding: { ...outcome.binding, baseSha: RISK_BASE, headSha: RISK_HEAD },
	}
}

layer(Layer.empty)('PublishRunService fails closed while rating', test => {
	test.effect('a failed prior read fails the rating when the gate is on', () =>
		Effect.gen(function* () {
			const fixture = setup(
				false,
				undefined,
				RISK_RULES,
				undefined,
				UNAVAILABLE,
				riskSpyLayer().spyLayer,
				APP_IDENTITY
			)
			expect(
				yield* PublishRunService.use(service =>
					service.run(boundOutcomeFile(), RATED_CONTEXT)
				).pipe(Effect.provide(fixture.service))
			).toMatchObject({ status: 'failed', risk: { status: 'failed' } })
		})
	)
	test.effect(
		'rules that do not load fail the rating when the settings rate',
		() =>
			Effect.gen(function* () {
				const fixture = setup(
					false,
					new ConfigError({ source: '.mng/review.yml', reason: 'Invalid.' }),
					RISK_RULES,
					undefined,
					undefined,
					riskSpyLayer().spyLayer,
					APP_IDENTITY
				)
				expect(
					yield* PublishRunService.use(service =>
						service.run(boundOutcomeFile(), RATED_CONTEXT)
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({ status: 'failed', risk: { status: 'failed' } })
			})
	)
	test.effect(
		'a failed publish after step one writes the unfinished status, then revokes, and fails',
		() =>
			Effect.gen(function* () {
				const { fake, fixture } = liveRiskSetup()
				fixture.publishSpy.mockImplementation(() =>
					Effect.fail(new PublishIncompleteError({ error: UNAVAILABLE }))
				)
				const riskWritesAtUnfinished: number[] = []
				fixture.reportUnfinishedSpy.mockImplementation(() =>
					Effect.sync(() => {
						riskWritesAtUnfinished.push(fake.writes.length)
						return true
					})
				)
				expect(
					yield* PublishRunService.use(service =>
						service.run(liveRiskOutcome(), LIVE_RATED_CONTEXT)
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({ status: 'failed', risk: { status: 'failed' } })
				expect(fixture.publishSpy).toHaveBeenCalledOnce()
				expect(riskWritesAtUnfinished).toEqual([1])
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'error',
				])
				expect(fake.writes[1]?.description).toBe(fake.writes[0]?.description)
			})
	)
	test.effect(
		'a refused MNG Review status fails the rating and writes no grant',
		() =>
			Effect.gen(function* () {
				const { fake, fixture } = liveRiskSetup()
				fixture.reportSpy.mockImplementation(() =>
					Effect.succeed({ checks: 1, status: false })
				)
				expect(
					yield* PublishRunService.use(service =>
						service.run(liveRiskOutcome(), LIVE_RATED_CONTEXT)
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({ status: 'failed', risk: { status: 'failed' } })
				expect(fixture.reportUnfinishedSpy).toHaveBeenCalledOnce()
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'error',
				])
			})
	)
	test.effect(
		'a refused MNG Review status stays best effort while the rating is off',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.reportSpy.mockImplementation(() =>
					Effect.succeed({ checks: 1, status: false })
				)
				expect(
					yield* PublishRunService.use(service =>
						service.run(
							outcomeFile({ status: 'reviewed', report: reviewReport() }),
							CONTEXT
						)
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({
					status: 'published',
					checks: { checks: 1, status: false },
				})
				expect(fixture.reportUnfinishedSpy).not.toHaveBeenCalled()
			})
	)
	test.effect(
		'a run agent publish that fails part way writes the unfinished status before the thread raise',
		() =>
			Effect.gen(function* () {
				const risk = riskSpyLayer()
				const fixture = setup(
					false,
					undefined,
					RISK_RULES,
					undefined,
					undefined,
					risk.spyLayer,
					APP_IDENTITY
				)
				fixture.publishSpy.mockImplementation(() =>
					Effect.fail(new PublishIncompleteError({ error: UNAVAILABLE }))
				)
				yield* PublishRunService.use(service =>
					service.run(
						outcomeFile({ status: 'reviewed', report: reviewReport() }),
						{ ...RATED_CONTEXT, command: { agentOnly: true } }
					)
				).pipe(Effect.provide(fixture.service))
				expect(fixture.reportUnfinishedSpy).toHaveBeenCalledOnce()
				expect(risk.rateThreadSpy).toHaveBeenCalledOnce()
				expect(
					fixture.reportUnfinishedSpy.mock.invocationCallOrder[0]
				).toBeLessThan(risk.rateThreadSpy.mock.invocationCallOrder[0] ?? 0)
			})
	)
	test.effect(
		'a run agent publish that fails still runs the thread raise and fails',
		() =>
			Effect.gen(function* () {
				const risk = riskSpyLayer()
				const fixture = setup(
					true,
					undefined,
					RISK_RULES,
					undefined,
					undefined,
					risk.spyLayer,
					APP_IDENTITY
				)
				expect(
					yield* PublishRunService.use(service =>
						service.run(
							outcomeFile({ status: 'reviewed', report: reviewReport() }),
							{ ...RATED_CONTEXT, command: { agentOnly: true } }
						)
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({ status: 'failed', risk: { status: 'failed' } })
				expect(risk.rateThreadSpy).toHaveBeenCalledOnce()
			})
	)
	test.effect(
		'a converse that fails after posting raises for the threads it kept open and fails',
		() =>
			Effect.gen(function* () {
				const risk = riskSpyLayer()
				const publishSpy = vi.fn<ReplyPublishService['Service']['publish']>(
					() => Effect.fail(UNAVAILABLE)
				)
				const fixture = setup(
					false,
					undefined,
					RISK_RULES,
					undefined,
					undefined,
					risk.spyLayer,
					APP_IDENTITY,
					publishSpy
				)
				const reply = {
					fingerprint: 'fingerprint',
					commentId: 1,
					digest: 'digest',
				} as const
				const replied = yield* PublishRunService.use(service =>
					service.run(
						{
							version: 1,
							binding: { ...BINDING, trigger: 'converse' },
							status: 'replied',
							replies: {
								decided: [
									{
										...reply,
										threadId: 'closed',
										decision: { action: 'resolved', reason: 'Fixed.' },
									},
									{ ...reply, threadId: 'kept', decision: { action: 'seen' } },
								],
								tokens: {},
							},
						},
						{ ...RATED_CONTEXT, converse: true }
					)
				).pipe(Effect.provide(fixture.service))
				expect(replied).toMatchObject({
					status: 'failed',
					risk: { status: 'failed' },
				})
				expect(publishSpy).toHaveBeenCalledOnce()
				expect(risk.rateThreadSpy.mock.calls[0]?.[1]).toMatchObject({
					answered: ['kept'],
					defaultBranch: RATED_CONTEXT.risk.defaultBranch,
				})
			})
	)
})

/** A spy body that records the run's list reading in `seen`, then runs `value`. */
function recording<TValue, TError>(
	seen: boolean[],
	value: Effect.Effect<TValue, TError>
) {
	return () =>
		ListCompleteness.pipe(
			Effect.flatMap(reading => {
				seen.push(reading.complete)
				return value
			})
		)
}

layer(Layer.empty)('PublishRunService list completeness', test => {
	const OUTSIDE_CONTEXT = {
		...RATED_CONTEXT,
		event: { ...EVENT, pr: { ...EVENT.pr, target: 'release' } },
	} as const satisfies PublishContext
	const READINGS = [
		['the rating off', RULES, CONTEXT, GITHUB_ACTIONS_IDENTITY, false],
		[
			'rules that rate a pull request outside the default branch',
			RISK_RULES,
			OUTSIDE_CONTEXT,
			APP_IDENTITY,
			true,
		],
		['the rating on', RISK_RULES, RATED_CONTEXT, APP_IDENTITY, true],
	] as const
	const NULL_NODE = new GitHubApiError({
		operation: 'listThreads',
		reason: 'GitHub listed an entry as a null node',
	})
	for (const [name, rules, context, identity, complete] of READINGS)
		test.effect(
			`with ${name}, the prior read and the publish read complete lists: ${complete}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup(
						false,
						undefined,
						rules,
						undefined,
						undefined,
						riskSpyLayer().spyLayer,
						identity
					)
					const seen: boolean[] = []
					fixture.readPriorSpy.mockImplementation(
						recording(seen, Effect.succeed(undefined))
					)
					fixture.publishSpy.mockImplementation(
						recording(seen, Effect.succeed(PUBLISHED))
					)
					expect(
						yield* PublishRunService.use(service =>
							service.run(boundOutcomeFile(), context)
						).pipe(Effect.provide(fixture.service))
					).toMatchObject({ status: 'published' })
					expect(seen).toEqual([complete, complete])
				})
		)
	for (const [name, rules, context, identity, complete] of READINGS)
		test.effect(
			`with ${name}, the reply publish and its thread raise read complete lists: ${complete}`,
			() =>
				Effect.gen(function* () {
					const seen: boolean[] = []
					const risk = riskSpyLayer()
					risk.rateThreadSpy.mockImplementation(
						recording(seen, Effect.succeed({ status: 'none' } as const))
					)
					const fixture = setup(
						false,
						undefined,
						rules,
						undefined,
						undefined,
						risk.spyLayer,
						identity,
						recording(seen, Effect.fail(UNAVAILABLE))
					)
					expect(
						yield* PublishRunService.use(service =>
							service.run(
								{
									version: 1,
									binding: { ...BINDING, trigger: 'converse' },
									status: 'replied',
									replies: {
										decided: [
											{
												fingerprint: 'fingerprint',
												commentId: 1,
												digest: 'digest',
												threadId: 'kept',
												decision: { action: 'seen' },
											},
										],
										tokens: {},
									},
								},
								{ ...context, converse: true }
							)
						).pipe(Effect.provide(fixture.service))
					).toMatchObject({ status: 'failed' })
					expect(seen).toEqual([complete, complete])
				})
		)
	for (const [name, rules, context, identity, complete] of READINGS)
		test.effect(
			`with ${name}, an agent-only run's publish and thread raise read complete lists: ${complete}`,
			() =>
				Effect.gen(function* () {
					const seen: boolean[] = []
					const risk = riskSpyLayer()
					risk.rateThreadSpy.mockImplementation(
						recording(seen, Effect.succeed({ status: 'none' } as const))
					)
					const fixture = setup(
						false,
						undefined,
						rules,
						undefined,
						undefined,
						risk.spyLayer,
						identity
					)
					fixture.publishSpy.mockImplementation(
						recording(seen, Effect.succeed(PUBLISHED))
					)
					expect(
						yield* PublishRunService.use(service =>
							service.run(boundOutcomeFile(), {
								...context,
								event: {
									...context.event,
									pr: { ...context.event.pr, trigger: 'manual' },
								},
								command: { agentOnly: true, agent: 'auth' },
							})
						).pipe(Effect.provide(fixture.service))
					).toMatchObject({ status: 'published' })
					expect(risk.rateThreadSpy).toHaveBeenCalledOnce()
					expect(seen).toEqual([complete, complete])
				})
		)
	test.effect(
		'a refused-gate publish in a rating-on repository fails on a null node and clears no wait',
		() =>
			Effect.gen(function* () {
				// The publish spy fakes the adapter's null-node failure; the adapter itself is
				// covered by publish.service.spec and the github-api adapter specs.
				const fixture = setup(
					false,
					undefined,
					RISK_RULES,
					undefined,
					undefined,
					riskSpyLayer().spyLayer,
					APP_IDENTITY
				)
				// The adapter fails a complete read on a null node; a lenient read leaves it out, and
				// the owner's resolution then clears the wait.
				fixture.publishSpy.mockImplementation(() =>
					ListCompleteness.pipe(
						Effect.flatMap(reading =>
							reading.complete
								? Effect.fail(NULL_NODE)
								: Effect.succeed({ ...PUBLISHED, waiting: 0 })
						)
					)
				)
				expect(
					yield* PublishRunService.use(service =>
						service.run(boundOutcomeFile(), OUTSIDE_CONTEXT)
					).pipe(Effect.provide(fixture.service))
				).toMatchObject({ status: 'failed', reason: NULL_NODE.message })
				expect(fixture.publishSpy).toHaveBeenCalledOnce()
				expect(fixture.reportSpy).not.toHaveBeenCalled()
			})
	)
})
