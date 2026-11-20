import { layer } from '@effect/vitest'
import {
	GitHubApiError,
	GitHubConfig,
	GitHubWriteConfigLive,
	parseSummaryMarker,
	toMarkerComment,
} from '@mng-review/github'
import { Effect, FileSystem } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires shared GitHub fixtures.
import {
	reviewThread,
	appSummary,
	SUMMARY_MARKER,
} from '../../../../../packages/github/src/shared/mocks/publish-test.helper'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires shared GitHub reply fixtures.
import {
	decidedReply,
	pendingReviewThread,
} from '../../../../../packages/github/src/shared/mocks/thread-reply-test.helper'
import { PublishRunService } from '../../application/publish-run.service'
import {
	MAX_OUTCOME_BYTES,
	type OutcomeBinding,
} from '../../infrastructure/outcome-file.schema'
import { parsePullRequestEvent } from '../../infrastructure/pull-request-event.parser'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { eventPayload } from '../../shared/mocks/pull-request-event.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import {
	failPublishConfig,
	publishMissingOutcome,
	runPublishStep,
} from './publish-step.handler'

afterEach(() => {
	cleanupRepos()
})

layer(FileSystemLayer, { excludeTestServices: true })(
	'publish step with no endpoint variables or model layer',
	test => {
		for (const scenario of [
			'missing',
			'oversized',
			'version 2',
			'repository',
			'runId',
			'runAttempt',
			'engineCommit',
			'pullNumber',
			'baseSha',
			'headSha',
		] as const)
			test.effect(`${scenario} posts nothing and exits 1`, () =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const fs = yield* FileSystem.FileSystem
					const binding: OutcomeBinding = {
						...fixture.file.binding,
						...(scenario === 'repository'
							? { repository: 'example/other' }
							: {}),
						...(scenario === 'runId' ? { runId: '456' } : {}),
						...(scenario === 'runAttempt' ? { runAttempt: '2' } : {}),
						...(scenario === 'engineCommit'
							? { engineCommit: 'd'.repeat(40) }
							: {}),
						...(scenario === 'pullNumber' ? { pullNumber: 18 } : {}),
						...(scenario === 'baseSha' ? { baseSha: 'd'.repeat(40) } : {}),
						...(scenario === 'headSha' ? { headSha: 'e'.repeat(40) } : {}),
					}
					if (scenario !== 'missing')
						yield* fs.writeFileString(
							fixture.paths.outcome,
							scenario === 'oversized'
								? ' '.repeat(MAX_OUTCOME_BYTES + 1)
								: JSON.stringify({
										...fixture.file,
										version: scenario === 'version 2' ? 2 : 1,
										binding,
									})
						)
					expect(
						yield* runPublishStep.pipe(
							Effect.provide(fixture.publishRunLayer),
							Effect.provide(fixture.envLayer()),
							Effect.flip
						)
					).toMatchObject({ _tag: 'ActionExit', code: 1 })
					expect(fixture.api.writes).toEqual([])
					expect(fixture.status.checks).toEqual([])
					expect(fixture.status.statuses).toEqual([])
					expect(fixture.loads).toEqual([])
					const summary = yield* fs.readFileString(fixture.paths.summary)
					if (scenario === 'runAttempt')
						expect(summary).toContain('re-run all jobs')
					if (
						[
							'repository',
							'runId',
							'runAttempt',
							'engineCommit',
							'pullNumber',
							'baseSha',
							'headSha',
						].includes(scenario)
					)
						expect(summary).toContain(`${scenario} differs`)
				})
			)

		for (const status of ['reviewed', 'offline'] as const)
			test.effect(
				`a correctly bound ${status} outcome for a draft event posts nothing`,
				() =>
					Effect.gen(function* () {
						const fixture = stepFixture()
						const fs = yield* FileSystem.FileSystem
						const payload = eventPayload()
						yield* fs.writeFileString(
							fixture.environment.GITHUB_EVENT_PATH,
							JSON.stringify({
								...payload,
								pull_request: {
									...payload.pull_request,
									draft: true,
									base: { ...payload.pull_request.base, sha: fixture.base },
									head: { ...payload.pull_request.head, sha: fixture.head },
								},
							})
						)
						yield* fs.writeFileString(
							fixture.paths.outcome,
							JSON.stringify({
								...fixture.file,
								status,
								...(status === 'offline' ? { reason: 'no endpoint' } : {}),
							})
						)
						yield* fs.writeFileString(
							fixture.paths.result,
							JSON.stringify({ version: 1 })
						)
						yield* runPublishStep.pipe(
							Effect.provide(fixture.publishRunLayer),
							Effect.provide(fixture.envLayer())
						)
						expect(fixture.api.writes).toEqual([])
						expect(fixture.status.checks).toEqual([])
						expect(fixture.status.statuses).toEqual([])
						expect(fixture.loads).toEqual([fixture.base])
						expect(
							JSON.parse(yield* fs.readFileString(fixture.paths.result))
						).toEqual({
							version: 1,
							publish: {
								status: 'not-published',
								reason: 'draft pull request (skip.drafts)',
							},
						})
					})
			)
		for (const resultExists of [true, false])
			test.effect(
				`a matching outcome preserves layer-one publishing with result present=${resultExists}`,
				() =>
					Effect.gen(function* () {
						const direct = stepFixture()
						const fs = yield* FileSystem.FileSystem
						const context = {
							engineCommit: direct.file.binding.engineCommit ?? undefined,
							pullNumber: direct.file.binding.pullNumber,
							head: direct.head,
							event: yield* parsePullRequestEvent(
								yield* fs.readFileString(direct.environment.GITHUB_EVENT_PATH)
							),
						}
						const expected = yield* PublishRunService.use(service =>
							service.run(direct.file, context)
						).pipe(Effect.provide(direct.publishRunLayer))
						expect(expected.status).toBe('published')
						const expectedWrites = structuredClone(direct.api.writes)
						const expectedChecks = structuredClone(direct.status.checks)
						const expectedStatuses = structuredClone(direct.status.statuses)
						direct.api.writes.splice(0)
						direct.api.threads.splice(0)
						direct.api.comments.splice(0)
						direct.status.checks.splice(0)
						direct.status.statuses.splice(0)
						const fixture = direct
						const { file } = fixture
						yield* fs.writeFileString(
							fixture.paths.outcome,
							JSON.stringify(file)
						)
						const original = {
							version: 1,
							mode: 'publish',
							publish: null,
							nested: { values: [1, false, null] },
							custom: 'kept',
						} as const
						if (resultExists)
							yield* fs.writeFileString(
								fixture.paths.result,
								JSON.stringify(original)
							)
						yield* runPublishStep.pipe(
							Effect.provide(fixture.publishRunLayer),
							Effect.provide(fixture.envLayer())
						)
						expect(fixture.api.writes).toEqual(expectedWrites)
						expect(fixture.status.checks).toEqual(expectedChecks)
						expect(fixture.status.statuses).toEqual(expectedStatuses)
						if (resultExists)
							expect(
								JSON.parse(yield* fs.readFileString(fixture.paths.result))
							).toEqual({ ...original, publish: expected })
						else expect(yield* fs.exists(fixture.paths.result)).toBe(false)
					})
			)
	}
)

layer(FileSystemLayer, { excludeTestServices: true })(
	'publish app configuration',
	test => {
		for (const settings of [
			{ MNG_REVIEW_APP_SLUG: 'mng-review' },
			{ MNG_REVIEW_APP_TOKEN: 'app-fixture' },
			{
				MNG_REVIEW_APP_SLUG: 'mng-review',
				MNG_REVIEW_APP_TOKEN: 'app-fixture',
				MNG_REVIEW_MINTED_APP_SLUG: 'other-app',
			},
			{
				GITHUB_TOKEN: 'job-fixture',
				MNG_REVIEW_APP_SLUG: 'mng-review',
				MNG_REVIEW_APP_TOKEN: 'app-fixture',
				MNG_REVIEW_MINTED_APP_SLUG: 'mng-review',
			},
		])
			test.effect(
				`broken app configuration exits 2 before a request: ${Object.keys(settings).join(',')}`,
				() =>
					Effect.gen(function* () {
						const fixture = stepFixture()
						expect(
							yield* GitHubConfig.pipe(
								Effect.provide(GitHubWriteConfigLive),
								Effect.flatMap(() =>
									runPublishStep.pipe(Effect.provide(fixture.publishRunLayer))
								),
								Effect.catchTag('ConfigError', failPublishConfig),
								Effect.provide(
									fixture.envLayer(Object.fromEntries(Object.entries(settings)))
								),
								Effect.flip
							)
						).toMatchObject({ _tag: 'ActionExit', code: 2 })
						expect(fixture.api.writes).toEqual([])
						expect(fixture.api.threadReads).toEqual([])
						expect(fixture.api.commentReads).toEqual([])
						expect(fixture.status.checks).toEqual([])
						expect(fixture.status.statuses).toEqual([])
						expect(fixture.loads).toEqual([])
						expect(
							yield* (yield* FileSystem.FileSystem).readFileString(
								fixture.paths.summary
							)
						).toContain('publishing failed')
					})
			)
		test.effect('the published result file includes cleanup', () =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const fs = yield* FileSystem.FileSystem
				yield* fs.writeFileString(
					fixture.paths.outcome,
					JSON.stringify(fixture.file)
				)
				yield* fs.writeFileString(
					fixture.paths.result,
					JSON.stringify({ version: 1 })
				)
				yield* runPublishStep.pipe(
					Effect.provide(fixture.publishRunLayer),
					Effect.provide(fixture.envLayer())
				)
				expect(
					JSON.parse(yield* fs.readFileString(fixture.paths.result))
				).toMatchObject({
					publish: { status: 'published', result: { cleanup: 'none' } },
				})
			})
		)
	}
)

layer(FileSystemLayer, { excludeTestServices: true })(
	'publish command trust boundary',
	test => {
		for (const [scenario, reason] of [
			['closed', 'the pull request closed after the command'],
			['fork', 'the pull request comes from a fork'],
			['deleted head repository', 'the pull request comes from a fork'],
		] as const)
			test.effect(
				`a command on a ${scenario} pull request posts nothing and exits 1`,
				() =>
					Effect.gen(function* () {
						const fixture = stepFixture()
						const fs = yield* FileSystem.FileSystem
						const pr = fixture.api.command.pullRequest
						fixture.api.command.pullRequest = {
							...pr,
							state: scenario === 'closed' ? 'closed' : 'open',
							base: { ...pr.base, sha: fixture.base },
							head: {
								sha: fixture.head,
								repo:
									scenario === 'fork'
										? { full_name: 'example/fork' }
										: scenario === 'deleted head repository'
											? null
											: pr.base.repo,
							},
						}
						yield* fs.writeFileString(
							fixture.paths.outcome,
							JSON.stringify({
								...fixture.file,
								binding: { ...fixture.file.binding, trigger: 'command' },
							})
						)
						yield* fs.writeFileString(
							fixture.paths.result,
							JSON.stringify({ version: 1 })
						)
						expect(
							yield* runPublishStep.pipe(
								Effect.provide(fixture.publishRunLayer),
								Effect.provide(
									fixture.envLayer({
										MNG_REVIEW_TRIGGER: 'command',
										MNG_REVIEW_TARGET_PR: '17',
										MNG_REVIEW_TARGET_BASE: fixture.base,
										MNG_REVIEW_TARGET_HEAD: fixture.head,
									})
								),
								Effect.flip
							)
						).toMatchObject({ _tag: 'ActionExit', code: 1 })
						expect(fixture.api.reads).toEqual(['getPullRequest:17'])
						expect(fixture.api.writes).toEqual([])
						expect(fixture.api.threads).toEqual([])
						expect(fixture.api.comments).toEqual([])
						expect(fixture.status.statuses).toEqual([])
						expect(fixture.status.checks).toEqual([])
						expect(fixture.loads).toEqual([])
						expect(yield* fs.readFileString(fixture.paths.summary)).toContain(
							reason
						)
						expect(
							JSON.parse(yield* fs.readFileString(fixture.paths.result))
						).toEqual({ version: 1, publish: { status: 'failed', reason } })
					})
			)

		for (const moved of [false, true])
			test.effect(
				`a completed command publishes with moved head=${moved} and finishes only the current head`,
				() =>
					Effect.gen(function* () {
						const fixture = stepFixture()
						const fs = yield* FileSystem.FileSystem
						fixture.repo.write(
							'src/items/store.ts',
							'first\nnewer value\nlast\n'
						)
						const movedHead = fixture.repo.commit()
						const pr = fixture.api.command.pullRequest
						fixture.api.command.pullRequest = {
							...pr,
							base: { ...pr.base, sha: fixture.base },
							head: { ...pr.head, sha: moved ? movedHead : fixture.head },
						}
						yield* fs.writeFileString(
							fixture.paths.outcome,
							JSON.stringify({
								...fixture.file,
								binding: { ...fixture.file.binding, trigger: 'command' },
								report: {
									...fixture.report,
									agents: fixture.report.agents.filter(
										agent => agent.status === 'ok'
									),
								},
							})
						)
						yield* fs.writeFileString(
							fixture.paths.result,
							JSON.stringify({ version: 1 })
						)
						yield* runPublishStep.pipe(
							Effect.provide(fixture.publishRunLayer),
							Effect.provide(
								fixture.envLayer({
									MNG_REVIEW_TRIGGER: 'command',
									MNG_REVIEW_TARGET_PR: '17',
									MNG_REVIEW_TARGET_BASE: fixture.base,
									MNG_REVIEW_TARGET_HEAD: fixture.head,
								})
							)
						)
						expect(
							JSON.parse(yield* fs.readFileString(fixture.paths.result))
						).toMatchObject({
							publish: {
								status: 'published',
								result: { verdict: 'needs fixes', finished: !moved },
							},
						})
						expect(fixture.api.threads.length).toBeGreaterThan(0)
						expect(fixture.api.comments).toHaveLength(1)
						expect(fixture.api.comments[0]?.body).toContain(
							'Verdict: needs fixes'
						)
						expect(fixture.status.statuses).toHaveLength(1)
						expect(fixture.status.statuses[0]).toMatchObject({
							sha: fixture.head,
							state: 'failure',
						})
						expect(fixture.status.checks.length).toBeGreaterThan(0)
						expect(
							fixture.status.checks.every(
								check => check.headSha === fixture.head
							)
						).toBeTruthy()
						expect(fixture.api.reads).toEqual([
							'getPullRequest:17',
							'getPullRequest:17',
						])
					})
			)

		for (const agent of ['', 'storage'])
			test.effect(
				`takes agentOnly from environment agent=${agent || 'all'} and ignores the file's planted command`,
				() =>
					Effect.gen(function* () {
						const fixture = stepFixture()
						const fs = yield* FileSystem.FileSystem
						yield* fs.writeFileString(
							fixture.paths.outcome,
							JSON.stringify({
								...fixture.file,
								binding: { ...fixture.file.binding, trigger: 'command' },
								command: { agentOnly: agent === '' },
							})
						)
						const runSpy = vi.fn(
							(
								_outcome: Parameters<PublishRunService['Service']['run']>[0],
								_context: Parameters<PublishRunService['Service']['run']>[1]
							) =>
								Effect.succeed({
									status: 'not-published' as const,
									reason: 'recording boundary',
								})
						)
						yield* runPublishStep.pipe(
							Effect.provideService(PublishRunService, { run: runSpy }),
							Effect.provide(fixture.api.api),
							Effect.provide(
								fixture.envLayer({
									MNG_REVIEW_TRIGGER: 'command',
									MNG_REVIEW_TARGET_PR: '17',
									MNG_REVIEW_TARGET_BASE: fixture.base,
									MNG_REVIEW_TARGET_HEAD: fixture.head,
									MNG_REVIEW_COMMAND_AGENT: agent,
									GITHUB_EVENT_PATH: `${fixture.repo.root}/missing.json`,
								})
							)
						)
						expect(runSpy).toHaveBeenCalledOnce()
						expect(runSpy.mock.calls[0]?.[0]).not.toHaveProperty('command')
						expect(runSpy.mock.calls[0]?.[1]).toMatchObject({
							command: { agentOnly: agent !== '' },
							pullNumber: 17,
							head: fixture.head,
							event: {
								baseSha: fixture.base,
								headSha: fixture.head,
								pr: { trigger: 'manual' },
							},
						})
						expect(fixture.api.reads).toEqual(['getPullRequest:17'])
						expect(fixture.api.writes).toEqual([])
					})
			)
		for (const trigger of ['push', 'command'] as const)
			test.effect(
				`refuses an outcome whose trigger differs from ${trigger}`,
				() =>
					Effect.gen(function* () {
						const fixture = stepFixture()
						const fs = yield* FileSystem.FileSystem
						yield* fs.writeFileString(
							fixture.paths.outcome,
							JSON.stringify({
								...fixture.file,
								binding: {
									...fixture.file.binding,
									trigger: trigger === 'push' ? 'command' : 'push',
								},
							})
						)
						expect(
							yield* runPublishStep.pipe(
								Effect.provide(fixture.publishRunLayer),
								Effect.provide(
									fixture.envLayer({
										MNG_REVIEW_TRIGGER: trigger,
										MNG_REVIEW_TARGET_PR: '17',
										MNG_REVIEW_TARGET_BASE: fixture.base,
										MNG_REVIEW_TARGET_HEAD: fixture.head,
									})
								),
								Effect.flip
							)
						).toMatchObject({ _tag: 'ActionExit', code: 1 })
						expect(yield* fs.readFileString(fixture.paths.summary)).toContain(
							'trigger differs'
						)
						expect(fixture.api.writes).toEqual([])
						expect(fixture.status.statuses).toEqual([])
						expect(fixture.status.checks).toEqual([])
						expect(fixture.loads).toEqual([])
					})
			)
		test.effect(
			'a clean single-agent command on an unreviewed head cannot mark it ready or successful',
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const fs = yield* FileSystem.FileSystem
					const pr = fixture.api.command.pullRequest
					fixture.api.command.pullRequest = {
						...pr,
						head: { ...pr.head, sha: fixture.head },
						base: { ...pr.base, sha: fixture.base },
					}
					yield* fs.writeFileString(
						fixture.paths.outcome,
						JSON.stringify({
							...fixture.file,
							binding: { ...fixture.file.binding, trigger: 'command' },
							report: { ...fixture.report, bugs: [], nits: [], rejected: [] },
						})
					)
					yield* fs.writeFileString(
						fixture.paths.result,
						JSON.stringify({ version: 1 })
					)
					yield* runPublishStep.pipe(
						Effect.provide(fixture.publishRunLayer),
						Effect.provide(
							fixture.envLayer({
								MNG_REVIEW_TRIGGER: 'command',
								MNG_REVIEW_TARGET_PR: '17',
								MNG_REVIEW_TARGET_BASE: fixture.base,
								MNG_REVIEW_TARGET_HEAD: fixture.head,
								MNG_REVIEW_COMMAND_AGENT: 'storage',
							})
						)
					)
					expect(
						JSON.parse(yield* fs.readFileString(fixture.paths.result))
					).toMatchObject({
						publish: {
							status: 'published',
							result: { verdict: 'incomplete', finished: false },
						},
					})
					expect(fixture.api.comments).toHaveLength(1)
					expect(fixture.api.comments[0]?.body).toContain('Verdict: incomplete')
					expect(fixture.api.comments[0]?.body).not.toContain('Verdict: ready')
					expect(fixture.status.statuses).toHaveLength(1)
					expect(fixture.status.statuses[0]).toHaveProperty('state', 'error')
				})
		)
	}
)

layer(FileSystemLayer, { excludeTestServices: true })(
	'publish planted reply decision',
	test => {
		test.effect(
			'a decision in the outcome cannot answer a thread with no pending reply',
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const fs = yield* FileSystem.FileSystem
					fixture.api.threads.push(reviewThread())
					yield* fs.writeFileString(
						fixture.paths.outcome,
						JSON.stringify({
							...fixture.file,
							replies: { decided: [decidedReply()], tokens: {} },
						})
					)
					yield* fs.writeFileString(
						fixture.paths.result,
						JSON.stringify({ version: 1 })
					)
					yield* runPublishStep.pipe(
						Effect.provide(fixture.publishRunLayer),
						Effect.provide(fixture.envLayer())
					)
					expect(
						fixture.api.writes.filter(
							write => write.method === 'reply' || write.method === 'resolve'
						)
					).toEqual([])
					expect(
						fixture.api.writes.some(write => write.method === 'create')
					).toBeTruthy()
				})
		)
	}
)

layer(FileSystemLayer)('publish converse', test => {
	for (const scenario of ['draft', 'head', 'base'] as const)
		for (const wrongRun of [false, true])
			test.effect(
				`converse with a new ${scenario} and wrong run=${wrongRun} posts nothing and exits ${wrongRun ? 1 : 0}`,
				() =>
					Effect.gen(function* () {
						const fixture = stepFixture()
						const fs = yield* FileSystem.FileSystem
						const pr = fixture.api.command.pullRequest
						fixture.api.command.pullRequest = {
							...pr,
							draft: scenario === 'draft',
							base: {
								...pr.base,
								sha: scenario === 'base' ? 'd'.repeat(40) : fixture.base,
							},
							head: {
								...pr.head,
								sha: scenario === 'head' ? 'e'.repeat(40) : fixture.head,
							},
						}
						yield* fs.writeFileString(
							fixture.paths.outcome,
							JSON.stringify({
								version: 1,
								binding: {
									...fixture.file.binding,
									trigger: 'converse',
									...(wrongRun ? { runId: '456' } : {}),
								},
								status: 'replied',
								replies: { decided: [decidedReply()], tokens: {} },
							})
						)
						yield* fs.writeFileString(
							fixture.paths.result,
							JSON.stringify({ version: 1 })
						)
						const completed = yield* runPublishStep.pipe(
							Effect.provide(fixture.publishRunLayer),
							Effect.provide(
								fixture.envLayer({
									MNG_REVIEW_TRIGGER: 'converse',
									MNG_REVIEW_TARGET_PR: '17',
									MNG_REVIEW_TARGET_BASE: fixture.base,
									MNG_REVIEW_TARGET_HEAD: fixture.head,
								})
							),
							Effect.result
						)
						if (wrongRun)
							expect(completed).toMatchObject({
								_tag: 'Failure',
								failure: { _tag: 'ActionExit', code: 1 },
							})
						else expect(completed._tag).toBe('Success')
						const reason = wrongRun
							? 'the outcome file belongs to another run: runId differs'
							: scenario === 'draft'
								? 'the pull request is a draft; replies are answered once it is ready'
								: `the pull request has a new ${scenario} since the schedule listed it; the next run reads it again`
						expect(
							JSON.parse(yield* fs.readFileString(fixture.paths.result))
						).toMatchObject({
							publish: {
								status: wrongRun ? 'failed' : 'not-published',
								reason,
							},
						})
						expect(yield* fs.readFileString(fixture.paths.summary)).toContain(
							reason
						)
						expect(fixture.api.reads).toEqual(['getPullRequest:17'])
						expect(fixture.api.writes).toEqual([])
						expect(fixture.status.checks).toEqual([])
						expect(fixture.status.statuses).toEqual([])
						expect(fixture.loads).toEqual([])
					})
			)
	for (const trigger of ['converse', 'push', 'command'] as const)
		test.effect(
			`a missing outcome for ${trigger} exits ${trigger === 'converse' ? 0 : 1} without GitHub writes`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const completed = yield* runPublishStep.pipe(
						Effect.provide(fixture.publishRunLayer),
						Effect.provide(fixture.envLayer({ MNG_REVIEW_TRIGGER: trigger })),
						Effect.result
					)
					if (trigger === 'converse') expect(completed._tag).toBe('Success')
					else
						expect(completed).toMatchObject({
							_tag: 'Failure',
							failure: { _tag: 'ActionExit', code: 1 },
						})
					expect(fixture.api.writes).toEqual([])
					expect(fixture.api.reads).toEqual([])
					expect(fixture.status.checks).toEqual([])
					expect(fixture.status.statuses).toEqual([])
					expect(fixture.loads).toEqual([])
				})
		)
	for (const trigger of ['converse', 'push'] as const)
		test.effect(
			`a missing outcome for ${trigger} is ${trigger === 'converse' ? '' : 'not '}reported before any publish service is built`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const fs = yield* FileSystem.FileSystem
					yield* fs.writeFileString(
						fixture.paths.result,
						JSON.stringify({ version: 1 })
					)
					const reported = yield* publishMissingOutcome.pipe(
						Effect.provide(fixture.envLayer({ MNG_REVIEW_TRIGGER: trigger }))
					)
					expect(reported).toBe(trigger === 'converse')
					const result = yield* fs.readFileString(fixture.paths.result)
					if (trigger === 'converse')
						expect(result).toContain('"not-published"')
					else expect(result).not.toContain('"publish"')
				})
		)
	for (const action of ['accepted', 'needs-owner'] as const)
		test.effect(
			`${action} updates the standing verdict with no new thread or check run`,
			() =>
				Effect.gen(function* () {
					// The shared bug is high: an accepted reply stands only when the rules accept up to it, and a
					// needs-owner answer only past that limit.
					const fixture = stepFixture(undefined, false, false, undefined, {
						accept_intentional_up_to: action === 'accepted' ? 'high' : 'medium',
						max_rounds: 1,
					})
					const fs = yield* FileSystem.FileSystem
					const pr = fixture.api.command.pullRequest
					fixture.api.command.pullRequest = {
						...pr,
						base: { ...pr.base, sha: fixture.base },
						head: { ...pr.head, sha: fixture.head },
					}
					fixture.api.threads.push(pendingReviewThread())
					const marker = {
						...SUMMARY_MARKER,
						runs: 4,
						manualRuns: 2,
						head: fixture.head,
						finished: true,
					}
					const body = `# MNG Review\n\n**Verdict: needs fixes** · risk normal (rules) · 1 open bug thread(s) · run 4 of 6\n\nKeep the model report and evidence.\n\n${toMarkerComment('summary', marker)}`
					fixture.api.comments.push(
						appSummary(marker, {
							body,
							author: { __typename: 'Bot', login: 'github-actions' },
						})
					)
					const decision =
						action === 'accepted'
							? ({
									action,
									reason: 'The caller guards it.',
									memory: 'Keep the guard.',
									evidence: ['src/items/store.ts:1'],
								} as const)
							: ({ action, reason: 'An owner must decide.' } as const)
					yield* fs.writeFileString(
						fixture.paths.outcome,
						JSON.stringify({
							version: 1,
							binding: { ...fixture.file.binding, trigger: 'converse' },
							status: 'replied',
							replies: { decided: [decidedReply(decision)], tokens: {} },
						})
					)
					yield* runPublishStep.pipe(
						Effect.provide(fixture.publishRunLayer),
						Effect.provide(
							fixture.envLayer({
								MNG_REVIEW_TRIGGER: 'converse',
								MNG_REVIEW_TARGET_PR: '17',
								MNG_REVIEW_TARGET_BASE: fixture.base,
								MNG_REVIEW_TARGET_HEAD: fixture.head,
							})
						)
					)
					const updated = fixture.api.comments[0]?.body ?? ''
					expect(parseSummaryMarker(updated)).toEqual({
						...marker,
						...(action === 'needs-owner' ? { needsOwner: ['thread'] } : {}),
					})
					expect(updated).toContain(
						`**Verdict: ${action === 'accepted' ? 'ready' : 'needs owner'}**`
					)
					expect(updated).toContain('run 4 of 6')
					expect(updated).toContain('Keep the model report and evidence.')
					expect(
						fixture.api.writes.filter(write =>
							['review', 'comment', 'create'].includes(write.method)
						)
					).toEqual([])
					expect(
						fixture.api.writes.filter(write => write.method === 'reply')
					).toHaveLength(1)
					expect(fixture.status.checks).toEqual([])
					expect(fixture.status.statuses).toMatchObject([
						{
							sha: fixture.head,
							state: action === 'accepted' ? 'success' : 'failure',
						},
					])
					expect(fixture.api.threads).toHaveLength(1)
				})
		)
	test.effect(
		'a reply whose author has no write access at publish is not answered',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const fs = yield* FileSystem.FileSystem
				const pr = fixture.api.command.pullRequest
				fixture.api.command.pullRequest = {
					...pr,
					base: { ...pr.base, sha: fixture.base },
					head: { ...pr.head, sha: fixture.head },
				}
				fixture.api.threads.push(pendingReviewThread())
				fixture.api.failures.getCollaboratorRole.push(
					new GitHubApiError({
						operation: 'role',
						reason: 'not found',
						status: 404,
					})
				)
				const marker = { ...SUMMARY_MARKER, runs: 4, head: fixture.head }
				fixture.api.comments.push(
					appSummary(marker, {
						author: { __typename: 'Bot', login: 'github-actions' },
					})
				)
				yield* fs.writeFileString(
					fixture.paths.outcome,
					JSON.stringify({
						version: 1,
						binding: { ...fixture.file.binding, trigger: 'converse' },
						status: 'replied',
						replies: {
							decided: [
								decidedReply({
									action: 'accepted',
									reason: 'The caller guards it.',
									memory: 'Keep the guard.',
									evidence: ['src/store.ts:10'],
								}),
							],
							tokens: {},
						},
					})
				)
				yield* runPublishStep.pipe(
					Effect.provide(fixture.publishRunLayer),
					Effect.provide(
						fixture.envLayer({
							MNG_REVIEW_TRIGGER: 'converse',
							MNG_REVIEW_TARGET_PR: '17',
							MNG_REVIEW_TARGET_BASE: fixture.base,
							MNG_REVIEW_TARGET_HEAD: fixture.head,
						})
					)
				)
				expect(
					fixture.api.writes.filter(write => write.method === 'reply')
				).toEqual([])
				expect(parseSummaryMarker(fixture.api.comments[0]?.body ?? '')).toEqual(
					marker
				)
			})
	)
	for (const finished of [false, true])
		test.effect(
			`a reply keeps finished=${finished}, the prior full head and unthreaded bugs`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const fs = yield* FileSystem.FileSystem
					const pr = fixture.api.command.pullRequest
					fixture.api.command.pullRequest = {
						...pr,
						base: { ...pr.base, sha: fixture.base },
						head: { ...pr.head, sha: fixture.head },
					}
					fixture.api.threads.push(pendingReviewThread())
					const marker = {
						...SUMMARY_MARKER,
						runs: 4,
						manualRuns: 2,
						head: fixture.base,
						finished,
						unthreadedBugs: 3,
					}
					fixture.api.comments.push(
						appSummary(marker, {
							author: { __typename: 'Bot', login: 'github-actions' },
						})
					)
					yield* fs.writeFileString(
						fixture.paths.outcome,
						JSON.stringify({
							version: 1,
							binding: { ...fixture.file.binding, trigger: 'converse' },
							status: 'replied',
							replies: { decided: [decidedReply()], tokens: {} },
						})
					)
					yield* runPublishStep.pipe(
						Effect.provide(fixture.publishRunLayer),
						Effect.provide(
							fixture.envLayer({
								MNG_REVIEW_TRIGGER: 'converse',
								MNG_REVIEW_TARGET_PR: '17',
								MNG_REVIEW_TARGET_BASE: fixture.base,
								MNG_REVIEW_TARGET_HEAD: fixture.head,
							})
						)
					)
					expect(
						parseSummaryMarker(fixture.api.comments[0]?.body ?? '')
					).toEqual(marker)
					expect(fixture.status.checks).toEqual([])
				})
		)
})
