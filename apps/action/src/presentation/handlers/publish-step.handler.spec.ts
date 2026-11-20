import { layer } from '@effect/vitest'
import { GitHubConfig, GitHubWriteConfigLive } from '@mng-review/github'
import { Effect, FileSystem } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires shared GitHub fixtures.
import { reviewThread } from '../../../../../packages/github/src/shared/mocks/publish-test.helper'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires shared GitHub reply fixtures.
import { decidedReply } from '../../../../../packages/github/src/shared/mocks/thread-reply-test.helper'
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
import { failPublishConfig, runPublishStep } from './publish-step.handler'

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
