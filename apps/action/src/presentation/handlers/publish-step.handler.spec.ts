import { layer } from '@effect/vitest'
import { Effect, FileSystem } from 'effect'
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
import { runPublishStep } from './publish-step.handler'

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
