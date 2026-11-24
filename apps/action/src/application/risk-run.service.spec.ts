import { layer } from '@effect/vitest'
import { DEFAULT_RISK_LABELS, parseRiskDescription } from '@mng-review/domain'
import {
	GitHubApiError,
	AnswerReadService,
	OwnedIdentities,
	toBotIdentity,
	RiskStartService,
	RiskFinishService,
	toAnswerEntry,
} from '@mng-review/github'
import { ConfigProvider, Effect, FileSystem, Layer } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires the shared in-memory risk fixture.
import {
	confirmedThread,
	riskFixture,
	riskInput,
	LOW_RATING,
} from '../../../../packages/github/src/shared/mocks/github-status-fake.helper'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires shared identity and thread fixtures.
import { APP_MODE_OWNED } from '../../../../packages/github/src/shared/mocks/publish-test.helper'
import { FileSystemLayer } from '../shared/mocks/git-test.helper'
import { RiskRunService, RiskRunServiceLive } from './risk-run.service'

/** Records runner output in memory while forbidding all unconfigured file access. */
function runnerFixture() {
	const fake = riskFixture()
	const output: string[] = []
	const fs = FileSystem.layerNoop({
		writeFileString: (_path, text) =>
			Effect.sync(() => {
				output.push(text)
			}),
	})
	const service = RiskRunServiceLive.pipe(
		Layer.provide(fake.services),
		Layer.provide(fs)
	)
	return { ...fake, output, service }
}

layer(
	Layer.merge(
		APP_MODE_OWNED,
		ConfigProvider.layer(
			ConfigProvider.fromEnvRecord({ GITHUB_OUTPUT: '/fixture/output' })
		)
	)
)('RiskRunService', test => {
	for (const failure of ['timeline', 'statuses'] as const)
		test.effect(
			`failed held ${failure} read publishes and writes nothing`,
			() =>
				Effect.gen(function* () {
					const fake = runnerFixture()
					fake.failures[failure].push(
						new GitHubApiError({ operation: 'read', reason: 'unavailable' })
					)
					const publishSpy = vi.fn(() => Effect.succeed('published'))
					expect(
						yield* RiskRunService.use(service =>
							service.rateFull({ status: 'on' }, riskInput(), publishSpy)
						).pipe(Effect.provide(fake.service))
					).toMatchObject({ value: undefined, risk: { status: 'failed' } })
					expect(publishSpy).not.toHaveBeenCalled()
					expect(fake.writes).toEqual([])
					expect(fake.api.writes).toEqual([])
					expect(fake.output).toEqual([])
				})
		)
	test.effect(
		'records step-one description before publishing and grants after publishing',
		() =>
			Effect.gen(function* () {
				const fake = runnerFixture()
				const publish = () =>
					Effect.sync(() => {
						expect(fake.writes.map(write => write.state)).toEqual(['error'])
						expect(fake.output).toEqual([
							`risk-description=${fake.writes[0]?.description}\n`,
						])
						expect(
							parseRiskDescription(fake.writes[0]?.description ?? '')?.nonce
						).toMatch(/^[0-9a-f]{16}$/u)
						return 'published'
					})
				expect(
					yield* RiskRunService.use(service =>
						service.rateFull({ status: 'on' }, riskInput(), publish)
					).pipe(Effect.provide(fake.service))
				).toMatchObject({
					value: 'published',
					risk: {
						status: 'written',
						result: { state: 'success', level: 'low' },
					},
				})
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'success',
				])
			})
	)
	test.effect(
		'a publish failure repeats the same High error and removes the bot label',
		() =>
			Effect.gen(function* () {
				const fake = runnerFixture()
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.high }],
				}
				const failure = new GitHubApiError({
					operation: 'publish',
					reason: 'unavailable',
				})
				expect(
					yield* RiskRunService.use(service =>
						service.rateFull(
							{ status: 'on' },
							riskInput({
								report: {
									...riskInput().report,
									rating: { ...LOW_RATING, model: 'high', level: 'high' },
								},
							}),
							() => Effect.fail(failure)
						)
					).pipe(Effect.provide(fake.service), Effect.flip)
				).toEqual(failure)
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'error',
				])
				expect(fake.writes[1]?.description).toBe(fake.writes[0]?.description)
				expect(fake.api.writes.at(-1)).toMatchObject({
					method: 'unlabel',
					name: DEFAULT_RISK_LABELS.high,
				})
			})
	)
	for (const gate of [
		{ status: 'off' },
		{ status: 'refused', reason: 'not rated: needs app' },
	] as const)
		test.effect(
			`${gate.status} publishes without a rating and writes no risk data`,
			() =>
				Effect.gen(function* () {
					const fake = runnerFixture()
					const publishSpy = vi.fn(() => Effect.succeed('published'))
					expect(
						yield* RiskRunService.use(service =>
							service.rateFull(gate, riskInput(), publishSpy)
						).pipe(Effect.provide(fake.service))
					).toEqual({ value: 'published', risk: gate })
					expect(publishSpy).toHaveBeenCalledWith(undefined)
					expect(
						yield* RiskRunService.use(service =>
							service.rateThread(gate, riskInput())
						).pipe(Effect.provide(fake.service))
					).toEqual(gate)
					expect(fake.writes).toEqual([])
					expect(fake.api.writes).toEqual([])
					expect(fake.reads).toEqual([])
				})
		)
	test.effect(
		'a thread run grants High failure through the same order and writes output for cleanup',
		() =>
			Effect.gen(function* () {
				const fake = runnerFixture()
				fake.threads.push(confirmedThread())
				expect(
					yield* RiskRunService.use(service =>
						service.rateThread({ status: 'on' }, riskInput())
					).pipe(Effect.provide(fake.service))
				).toMatchObject({
					status: 'written',
					result: { state: 'failure', level: 'high' },
				})
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'failure',
				])
				expect(fake.writes[0]?.apiWritesBefore).toBe(0)
				expect(fake.writes[1]?.apiWritesBefore).toBe(fake.api.writes.length)
				expect(fake.output).toEqual([
					`risk-description=${fake.writes[0]?.description}\n`,
				])
			})
	)
	test.effect('a thread run with no raise leaves every write untouched', () =>
		Effect.gen(function* () {
			const fake = runnerFixture()
			expect(
				yield* RiskRunService.use(service =>
					service.rateThread({ status: 'on' }, riskInput())
				).pipe(Effect.provide(fake.service))
			).toEqual({ status: 'none' })
			expect(fake.writes).toEqual([])
			expect(fake.api.writes).toEqual([])
			expect(fake.output).toEqual([])
		})
	)
})

layer(
	Layer.merge(
		FileSystemLayer,
		Layer.succeed(OwnedIdentities, {
			current: toBotIdentity('mng-review'),
			identities: [toBotIdentity('mng-review')],
		})
	)
)('RiskRunService command answers', test => {
	for (const status of ['on', 'off', 'refused'] as const)
		test.effect(
			`${status} gate names commands only when the app can rate`,
			() =>
				Effect.gen(function* () {
					const entry = toAnswerEntry(7, 'review', [
						{ id: 42, at: '2026-01-01T12:00:00Z', body: 'command' },
					])
					const getCommandEntrySpy = vi.fn(() => Effect.succeed(entry))
					const dependencies = Layer.mergeAll(
						Layer.succeed(AnswerReadService, {
							getCommandEntry: getCommandEntrySpy,
							readCommands: () => Effect.die('unused'),
							getCountedReviews: () => Effect.die('unused'),
						}),
						Layer.succeed(RiskStartService, {
							startFull: () => Effect.die('unused'),
							startThread: () => Effect.die('unused'),
						}),
						Layer.succeed(RiskFinishService, {
							finish: () => Effect.die('unused'),
							revoke: () => Effect.die('unused'),
							revokeHead: () => Effect.die('unused'),
						})
					)
					const request = {
						pullNumber: 17,
						run: 7,
						kind: 'review',
						before: '2026-01-01T12:30:00Z',
					} as const
					expect(
						yield* RiskRunService.use(service =>
							service.readAnswers(
								status === 'refused'
									? { status, reason: 'job token' }
									: { status },
								request
							)
						).pipe(
							Effect.provide(
								RiskRunServiceLive.pipe(Layer.provide(dependencies))
							)
						)
					).toEqual(status === 'on' ? [entry] : [])
					expect(getCommandEntrySpy).toHaveBeenCalledTimes(
						status === 'on' ? 1 : 0
					)
				})
		)
	test.effect(
		'a failed answer read names nothing so the commands remain held',
		() =>
			Effect.gen(function* () {
				const dependencies = Layer.mergeAll(
					Layer.succeed(AnswerReadService, {
						getCommandEntry: () =>
							Effect.fail(
								new GitHubApiError({
									operation: 'answers',
									reason: 'unavailable',
								})
							),
						readCommands: () => Effect.die('unused'),
						getCountedReviews: () => Effect.die('unused'),
					}),
					Layer.succeed(RiskStartService, {
						startFull: () => Effect.die('unused'),
						startThread: () => Effect.die('unused'),
					}),
					Layer.succeed(RiskFinishService, {
						finish: () => Effect.die('unused'),
						revoke: () => Effect.die('unused'),
						revokeHead: () => Effect.die('unused'),
					})
				)
				expect(
					yield* RiskRunService.use(service =>
						service.readAnswers(
							{ status: 'on' },
							{
								pullNumber: 17,
								run: 7,
								kind: 'review',
								before: '2026-01-01T12:30:00Z',
							}
						)
					).pipe(
						Effect.provide(RiskRunServiceLive.pipe(Layer.provide(dependencies)))
					)
				).toEqual([])
			})
	)
})
