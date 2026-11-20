import { layer } from '@effect/vitest'
import { ConfigError } from '@mng-review/domain'
import {
	EndpointProbeService,
	GitError,
	ReviewRunService,
} from '@mng-review/engine'
import { ReplyDecisionService, ThreadRecheckService } from '@mng-review/github'
import { Effect, FileSystem, Layer } from 'effect'
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
} from '../../shared/mocks/git-test.helper'
import { recheckProposals } from '../../shared/mocks/outcome-file.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { runReviewStep } from './review-step.handler'

const NO_REPLY_DECISIONS = Layer.succeed(ReplyDecisionService, {
	decide: () => Effect.succeed(undefined),
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
						const threads = proposals.rejected.map(entry => entry.thread)
						const prepared: PreparedRun =
							scenario === 'skipped'
								? { status: 'skipped', reason: 'draft', event }
								: scenario === 'no event'
									? { status: 'skipped', reason: 'not a pull request event' }
									: {
											status: 'ready',
											event,
											threads,
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
							Effect.provide(reviewLayer),
							Effect.provide(NO_REPLY_DECISIONS),
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
							} else expect(proposeSpy).not.toHaveBeenCalled()
						}
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
