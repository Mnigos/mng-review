import { layer } from '@effect/vitest'
import { ConfigError } from '@mng-review/domain'
import {
	EndpointProbeService,
	GitError,
	ReviewRunService,
	ReplyService,
	ModelHealthService,
	RepoToolsService,
	makeReplyLayer,
	TokenLedgerLive,
} from '@mng-review/engine'
import {
	ReplyDecisionService,
	ReplyDecisionServiceLive,
	ThreadRecheckService,
} from '@mng-review/github'
import { Effect, FileSystem, Layer } from 'effect'
import { HttpClient } from 'effect/http'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires shared GitHub reply fixtures.
import {
	decidedReply,
	pendingReply,
	pendingBotThread,
} from '../../../../../packages/github/src/shared/mocks/thread-reply-test.helper'
import {
	ConverseRunService,
	ConverseRunServiceLive,
} from '../../application/converse-run.service'
import { PrepareRunServiceLive } from '../../application/prepare-run.service'
import {
	ShadowRunService,
	ShadowRunServiceLive,
} from '../../application/shadow-run.service'
import type { PreparedRun } from '../../application/shadow-run.types'
import { parseOutcomeFile } from '../../infrastructure/outcome-file.parser'
import { parsePullRequestEvent } from '../../infrastructure/pull-request-event.parser'
import {
	cleanupRepos,
	FileSystemLayer,
	gitLayer,
} from '../../shared/mocks/git-test.helper'
import { recheckProposals } from '../../shared/mocks/outcome-file.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { runReviewStep } from './review-step.handler'

vi.mock('@mng-review/engine', async importOriginal => {
	const engine = await importOriginal<typeof import('@mng-review/engine')>()
	return { ...engine, makeReplyLayer: vi.fn(engine.makeReplyLayer) }
})

const NO_REPLY_DECISIONS = Layer.succeed(ReplyDecisionService, {
	decide: () => Effect.succeed(undefined),
})
/** A push or command run never takes the reply schedule's review. */
const NO_CONVERSE = Layer.succeed(ConverseRunService, {
	review: () => Effect.die('a push or command run never answers alone'),
})

afterEach(() => {
	cleanupRepos()
})

layer(FileSystemLayer)(
	'review step without any GitHub layer or token',
	test => {
		for (const scenario of [
			'reviewed',
			'offline',
			'skipped',
			'invalid-config',
			'git failure',
			'plan skipped',
			'no event',
		] as const)
			test.effect(
				`${scenario} writes the expected publish output and exit code`,
				() =>
					Effect.gen(function* () {
						const fixture = stepFixture()
						const fs = yield* FileSystem.FileSystem
						const event = yield* parsePullRequestEvent(
							yield* fs.readFileString(fixture.environment.GITHUB_EVENT_PATH)
						)
						const proposals = recheckProposals()
						const threads = [
							...proposals.rejected.map(entry => entry.thread),
							pendingBotThread({ commit: fixture.base }),
						]
						const prepared: PreparedRun =
							scenario === 'skipped'
								? { status: 'skipped', reason: 'draft', event }
								: scenario === 'no event'
									? { status: 'skipped', reason: 'not a pull request event' }
									: {
											status: 'ready',
											event,
											threads,
											replies: [
												pendingReply({
													body: 'PRIVATE_REPLY_BODY_FOR_PREPARED_FILE',
												}),
											],
											prior: { runs: 2, head: fixture.base },
										}
						yield* fs.writeFileString(
							fixture.paths.prepared,
							JSON.stringify(prepared)
						)
						const report =
							scenario === 'plan skipped'
								? {
										...fixture.report,
										planReport: {
											...fixture.report.planReport,
											plan: {
												...fixture.report.planReport.plan,
												skippedRun: 'skip rule',
											},
										},
									}
								: fixture.report
						const runSpy = vi.fn(() =>
							scenario === 'invalid-config'
								? Effect.fail(
										new ConfigError({
											source: '.mng/review.yml',
											reason: 'invalid rules',
										})
									)
								: scenario === 'git failure'
									? Effect.fail(
											new GitError({
												args: ['show'],
												exitCode: 128,
												stderr: 'missing object',
											})
										)
									: Effect.succeed(report)
						)
						const probeSpy = vi.fn(() =>
							Effect.succeed(
								scenario === 'offline'
									? { status: 'offline' as const, reason: 'unavailable' }
									: { status: 'online' as const }
							)
						)
						const proposeSpy = vi.fn(() => Effect.succeed(proposals))
						const decideSpy = vi.fn(() =>
							Effect.succeed({ decided: [decidedReply()], tokens: {} })
						)
						const reviewLayer = ShadowRunServiceLive.pipe(
							Layer.provide(PrepareRunServiceLive),
							Layer.provide(
								Layer.mergeAll(
									fixture.rulesLayer,
									Layer.succeed(ReviewRunService, { run: runSpy }),
									Layer.succeed(EndpointProbeService, { probe: probeSpy })
								)
							)
						)
						const completed = yield* runReviewStep.pipe(
							Effect.provide(NO_CONVERSE),
							Effect.provide(reviewLayer),
							Effect.provide(
								Layer.succeed(ReplyDecisionService, { decide: decideSpy })
							),
							Effect.provide(
								Layer.succeed(ThreadRecheckService, { propose: proposeSpy })
							),
							Effect.provide(fixture.envLayer()),
							Effect.result
						)
						if (scenario === 'invalid-config' || scenario === 'git failure')
							expect(completed).toMatchObject({
								_tag: 'Failure',
								failure: {
									_tag: 'ActionExit',
									code: scenario === 'invalid-config' ? 2 : 1,
								},
							})
						else expect(completed._tag).toBe('Success')
						expect(yield* fs.readFileString(fixture.paths.output)).toBe(
							`publish=${scenario === 'reviewed' || scenario === 'offline'}\n`
						)
						expect(
							JSON.parse(yield* fs.readFileString(fixture.paths.result))
						).toMatchObject({ mode: 'publish', publish: null })
						if (scenario === 'no event') {
							expect(yield* fs.exists(fixture.paths.outcome)).toBe(false)
							expect(probeSpy).not.toHaveBeenCalled()
						} else {
							const outcome = yield* parseOutcomeFile(
								yield* fs.readFileString(fixture.paths.outcome)
							)
							expect(outcome.binding).toMatchObject({
								baseSha: fixture.base,
								headSha: fixture.head,
							})
							if (scenario === 'reviewed') {
								expect(decideSpy).toHaveBeenCalledExactlyOnceWith(
									expect.objectContaining({
										threads,
										replies: [
											pendingReply({
												body: 'PRIVATE_REPLY_BODY_FOR_PREPARED_FILE',
											}),
										],
									})
								)
								expect(outcome.replies).toEqual({
									decided: [decidedReply()],
									tokens: {},
								})
								expect(
									yield* fs.readFileString(fixture.paths.outcome)
								).not.toContain('PRIVATE_REPLY_BODY_FOR_PREPARED_FILE')
								expect(proposeSpy).toHaveBeenCalledExactlyOnceWith(
									expect.objectContaining({
										threads,
										rotation: 2,
										head: fixture.head,
										rules: fixture.rules,
									})
								)
								expect(outcome.recheck).toMatchObject({
									checked: proposals.checked,
									rejected: proposals.rejected.map(entry => ({
										threadId: entry.thread.id,
										fingerprint: entry.thread.marker.fingerprint,
										reason: entry.reason,
									})),
								})
							} else {
								expect(proposeSpy).not.toHaveBeenCalled()
								expect(outcome.replies).toBeUndefined()
							}
						}
						if (scenario !== 'reviewed')
							expect(decideSpy).not.toHaveBeenCalled()
						if (scenario === 'skipped') expect(probeSpy).not.toHaveBeenCalled()
					})
			)
		for (const prepared of [
			undefined,
			'{',
			JSON.stringify({ status: 'unknown' }),
		])
			test.effect(
				`invalid prepared file ${prepared} returns config exit without probing`,
				() =>
					Effect.gen(function* () {
						const fixture = stepFixture()
						const fs = yield* FileSystem.FileSystem
						if (prepared !== undefined)
							yield* fs.writeFileString(fixture.paths.prepared, prepared)
						const reviewSpy = vi.fn((value: PreparedRun) => {
							expect(value).toMatchObject({
								status: 'invalid-config',
								source: 'MNG_REVIEW_PREPARED_PATH',
							})
							return Effect.succeed(
								value.status === 'ready'
									? { status: 'skipped' as const, reason: 'unexpected ready' }
									: value
							)
						})
						expect(
							yield* runReviewStep.pipe(
								Effect.provide(NO_CONVERSE),
								Effect.provide(
									Layer.succeed(ShadowRunService, {
										review: reviewSpy,
										run: () =>
											Effect.succeed({ status: 'skipped', reason: 'unused' }),
									})
								),
								Effect.provide(NO_REPLY_DECISIONS),
								Effect.provide(
									Layer.succeed(ThreadRecheckService, {
										propose: () => Effect.die('unexpected proposal'),
									})
								),
								Effect.provide(fixture.envLayer()),
								Effect.flip
							)
						).toMatchObject({ _tag: 'ActionExit', code: 2 })
						expect(yield* fs.exists(fixture.paths.outcome)).toBe(false)
						expect(yield* fs.readFileString(fixture.paths.output)).toBe(
							'publish=false\n'
						)
					})
			)
		test.effect(
			'an outcome whose file fails its own parse is never written and exits 1',
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const fs = yield* FileSystem.FileSystem
					const event = yield* parsePullRequestEvent(
						yield* fs.readFileString(fixture.environment.GITHUB_EVENT_PATH)
					)
					yield* fs.writeFileString(
						fixture.paths.prepared,
						JSON.stringify({
							status: 'ready',
							event,
							threads: [],
						} satisfies PreparedRun)
					)
					const reviewLayer = ShadowRunServiceLive.pipe(
						Layer.provide(PrepareRunServiceLive),
						Layer.provide(
							Layer.mergeAll(
								fixture.rulesLayer,
								Layer.succeed(ReviewRunService, {
									run: () => Effect.succeed(fixture.report),
								}),
								Layer.succeed(EndpointProbeService, {
									probe: () => Effect.succeed({ status: 'online' as const }),
								})
							)
						)
					)
					expect(
						yield* runReviewStep.pipe(
							Effect.provide(NO_CONVERSE),
							Effect.provide(reviewLayer),
							Effect.provide(NO_REPLY_DECISIONS),
							Effect.provide(
								Layer.succeed(ThreadRecheckService, {
									propose: () =>
										Effect.succeed({
											checked: 0,
											rejected: [],
											tokens: undefined,
										}),
								})
							),
							Effect.provide(
								fixture.envLayer({ MNG_REVIEW_ENGINE_COMMIT: 'not-a-commit' })
							),
							Effect.flip
						)
					).toMatchObject({ _tag: 'ActionExit', code: 1 })
					expect(yield* fs.exists(fixture.paths.outcome)).toBe(false)
					expect(yield* fs.readFileString(fixture.paths.output)).toBe(
						'publish=false\n'
					)
				})
		)
	}
)

layer(FileSystemLayer)('review command without GitHub services', test => {
	for (const depth of ['quick', 'deep'] as const)
		for (const agent of ['', 'storage'])
			for (const online of [true, false])
				test.effect(
					`${depth}, agent=${agent || 'all'}, online=${online} passes trusted options and suppresses offline publish`,
					() =>
						Effect.gen(function* () {
							const fixture = stepFixture()
							const fs = yield* FileSystem.FileSystem
							const event = yield* parsePullRequestEvent(
								yield* fs.readFileString(fixture.environment.GITHUB_EVENT_PATH)
							)
							const manualEvent = {
								...event,
								pr: { ...event.pr, trigger: 'manual', depth },
							} as const
							yield* fs.writeFileString(
								fixture.paths.prepared,
								JSON.stringify({
									status: 'ready',
									event: manualEvent,
									threads: [],
									prior: { runs: 3, head: fixture.base },
								})
							)
							const runSpy = vi.fn(
								(_input: Parameters<ReviewRunService['Service']['run']>[0]) =>
									Effect.succeed(fixture.report)
							)
							const probeSpy = vi.fn(() =>
								Effect.succeed(
									online
										? { status: 'online' as const }
										: { status: 'offline' as const, reason: 'unavailable' }
								)
							)
							const proposeSpy = vi.fn(() =>
								Effect.succeed({ checked: 0, rejected: [], tokens: {} })
							)
							yield* runReviewStep.pipe(
								Effect.provide(NO_CONVERSE),
								Effect.provide(
									ShadowRunServiceLive.pipe(
										Layer.provide(PrepareRunServiceLive),
										Layer.provide(
											Layer.mergeAll(
												fixture.rulesLayer,
												Layer.succeed(ReviewRunService, { run: runSpy }),
												Layer.succeed(EndpointProbeService, { probe: probeSpy })
											)
										)
									)
								),
								Effect.provide(NO_REPLY_DECISIONS),
								Effect.provide(
									Layer.succeed(ThreadRecheckService, { propose: proposeSpy })
								),
								Effect.provide(
									fixture.envLayer({
										GITHUB_EVENT_NAME: 'issue_comment',
										MNG_REVIEW_TRIGGER: 'command',
										MNG_REVIEW_TARGET_PR: '17',
										MNG_REVIEW_TARGET_BASE: fixture.base,
										MNG_REVIEW_TARGET_HEAD: fixture.head,
										MNG_REVIEW_COMMAND_DEPTH: depth,
										MNG_REVIEW_COMMAND_AGENT: agent,
									})
								)
							)
							expect(yield* fs.readFileString(fixture.paths.output)).toBe(
								`publish=${online}\n`
							)
							expect(probeSpy).toHaveBeenCalledOnce()
							const outcome = yield* parseOutcomeFile(
								yield* fs.readFileString(fixture.paths.outcome)
							)
							expect(outcome.binding).toMatchObject({
								trigger: 'command',
								baseSha: fixture.base,
								headSha: fixture.head,
							})
							if (online) {
								expect(runSpy).toHaveBeenCalledOnce()
								expect(runSpy.mock.calls[0]?.[0]).toMatchObject({
									baseRef: fixture.base,
									headRef: fixture.head,
									pr: { depth, trigger: 'manual' },
									...(agent ? { onlyAgent: agent } : {}),
								})
								expect(runSpy.mock.calls[0]?.[0]).not.toHaveProperty('since')
								if (!agent)
									expect(runSpy.mock.calls[0]?.[0]).not.toHaveProperty(
										'onlyAgent'
									)
							} else {
								expect(runSpy).not.toHaveBeenCalled()
								expect(proposeSpy).not.toHaveBeenCalled()
								expect(outcome.status).toBe('offline')
							}
							expect(fixture.api.reads).toEqual([])
							expect(fixture.api.writes).toEqual([])
						})
				)
})

layer(FileSystemLayer)('review reply decisions from the engine', test => {
	for (const error of [
		'model unavailable',
		'git unavailable',
		'budget exhausted',
	])
		test.effect(
			`an errored seen reply stays out of the outcome: ${error}`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const fs = yield* FileSystem.FileSystem
					const event = yield* parsePullRequestEvent(
						yield* fs.readFileString(fixture.environment.GITHUB_EVENT_PATH)
					)
					const replies = [
						pendingReply({ body: 'REPLY_BODY_FOR_RETRY' }),
						pendingReply({
							threadId: 'second',
							commentId: 43,
							body: 'REPLY_BODY_SEEN',
						}),
					]
					const threads = [
						pendingBotThread({ commit: fixture.base }),
						pendingBotThread({
							id: 'second',
							commit: fixture.base,
							latestCommentId: 43,
						}),
					]
					yield* fs.writeFileString(
						fixture.paths.prepared,
						JSON.stringify({
							status: 'ready',
							event,
							threads,
							replies,
						})
					)
					const decideSpy = vi.fn(
						(request: Parameters<ReplyService['Service']['decide']>[0]) =>
							Effect.succeed({
								results: request.items.map((item, index) => ({
									...item,
									decision: { action: 'seen' as const },
									...(index === 0 ? { error } : {}),
								})),
								tokens: {},
							})
					)
					vi.mocked(makeReplyLayer).mockReturnValueOnce(
						Layer.mergeAll(
							Layer.succeed(ReplyService, { decide: decideSpy }),
							Layer.mock(ModelHealthService, {}),
							Layer.mock(RepoToolsService, {})
						)
					)
					const httpSpy = vi.fn(() => Effect.die('unexpected HTTP request'))
					yield* runReviewStep.pipe(
						Effect.provide(NO_CONVERSE),
						Effect.provide(
							ShadowRunServiceLive.pipe(
								Layer.provide(PrepareRunServiceLive),
								Layer.provide(
									Layer.mergeAll(
										fixture.rulesLayer,
										Layer.succeed(ReviewRunService, {
											run: () => Effect.succeed(fixture.report),
										}),
										Layer.succeed(EndpointProbeService, {
											probe: () =>
												Effect.succeed({ status: 'online' as const }),
										})
									)
								)
							)
						),
						Effect.provide(
							ReplyDecisionServiceLive.pipe(
								Layer.provide(
									Layer.mergeAll(
										gitLayer(fixture.repo.root),
										TokenLedgerLive,
										Layer.succeed(
											HttpClient.HttpClient,
											HttpClient.make(httpSpy)
										)
									)
								)
							)
						),
						Effect.provide(
							Layer.succeed(ThreadRecheckService, {
								propose: () =>
									Effect.succeed({ checked: 0, rejected: [], tokens: {} }),
							})
						),
						Effect.provide(fixture.envLayer())
					)
					expect(decideSpy).toHaveBeenCalledExactlyOnceWith(
						expect.objectContaining({
							headRef: fixture.head,
							mergeBase: fixture.base,
							items: [
								expect.objectContaining({
									reply: replies[0]?.body,
									base: fixture.base,
								}),
								expect.objectContaining({
									reply: replies[1]?.body,
									base: fixture.base,
								}),
							],
						})
					)
					const text = yield* fs.readFileString(fixture.paths.outcome)
					expect((yield* parseOutcomeFile(text)).replies).toEqual({
						decided: [
							decidedReply(undefined, { threadId: 'second', commentId: 43 }),
						],
						tokens: {},
					})
					for (const reply of replies) expect(text).not.toContain(reply.body)
					expect(text).not.toContain(error)
					expect(httpSpy).not.toHaveBeenCalled()
				})
		)
})

layer(FileSystemLayer)('review converse without GitHub or a finder', test => {
	for (const scenario of ['replied', 'offline', 'no decision'] as const)
		test.effect(
			`${scenario} runs only reply decisions and writes a converse outcome`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const fs = yield* FileSystem.FileSystem
					const event = yield* parsePullRequestEvent(
						yield* fs.readFileString(fixture.environment.GITHUB_EVENT_PATH)
					)
					const threads = [pendingBotThread({ commit: fixture.base })]
					const replies = [pendingReply()]
					yield* fs.writeFileString(
						fixture.paths.prepared,
						JSON.stringify({ status: 'ready', event, threads, replies })
					)
					const decisions = {
						decided:
							scenario === 'no decision'
								? []
								: [
										decidedReply({
											action: 'needs-owner',
											reason: 'An owner must decide.',
										}),
									],
						tokens: {},
					}
					const decideSpy = vi.fn(() => Effect.succeed(decisions))
					const probeSpy = vi.fn(() =>
						Effect.succeed(
							scenario === 'offline'
								? { status: 'offline' as const, reason: 'unavailable' }
								: { status: 'online' as const }
						)
					)
					const reviewSpy = vi.fn(() => Effect.die('unexpected finder'))
					const runSpy = vi.fn(() => Effect.die('unexpected full review'))
					const proposeSpy = vi.fn(() =>
						Effect.die('unexpected validator re-check')
					)
					yield* runReviewStep.pipe(
						Effect.provide(
							ConverseRunServiceLive.pipe(
								Layer.provide(
									Layer.mergeAll(
										fixture.rulesLayer,
										gitLayer(fixture.repo.root),
										Layer.succeed(EndpointProbeService, { probe: probeSpy }),
										Layer.succeed(ReplyDecisionService, { decide: decideSpy })
									)
								)
							)
						),
						Effect.provide(
							Layer.succeed(ShadowRunService, {
								review: reviewSpy,
								run: runSpy,
							})
						),
						Effect.provide(
							Layer.succeed(ReplyDecisionService, { decide: decideSpy })
						),
						Effect.provide(
							Layer.succeed(ThreadRecheckService, { propose: proposeSpy })
						),
						Effect.provide(
							fixture.envLayer({
								GITHUB_EVENT_NAME: 'schedule',
								MNG_REVIEW_TRIGGER: 'converse',
							})
						)
					)
					expect(probeSpy).toHaveBeenCalledOnce()
					expect(reviewSpy).not.toHaveBeenCalled()
					expect(runSpy).not.toHaveBeenCalled()
					expect(proposeSpy).not.toHaveBeenCalled()
					expect(yield* fs.readFileString(fixture.paths.output)).toBe(
						`publish=${scenario === 'replied'}\n`
					)
					const outcome = yield* parseOutcomeFile(
						yield* fs.readFileString(fixture.paths.outcome)
					)
					expect(outcome.binding).toMatchObject({
						trigger: 'converse',
						baseSha: fixture.base,
						headSha: fixture.head,
					})
					expect(outcome.status).toBe(
						scenario === 'no decision' ? 'skipped' : scenario
					)
					expect(outcome.report).toBeUndefined()
					expect(outcome.recheck).toBeUndefined()
					if (scenario === 'offline') {
						expect(decideSpy).not.toHaveBeenCalled()
						expect(outcome.replies).toBeUndefined()
					} else {
						expect(decideSpy).toHaveBeenCalledExactlyOnceWith({
							rules: fixture.rules,
							pr: event.pr,
							head: fixture.head,
							mergeBase: fixture.base,
							threads,
							replies,
						})
						if (scenario === 'replied')
							expect(outcome.replies).toEqual(decisions)
					}
					expect(fixture.api.reads).toEqual([])
					expect(fixture.api.writes).toEqual([])
				})
		)
})
