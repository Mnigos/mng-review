import { layer } from '@effect/vitest'
import {
	GitHubApiError,
	GitHubConfig,
	GitHubStatusService,
	GitHubWriteConfigLive,
	OwnedIdentities,
	RiskStepOneError,
	RiskSweepService,
	toBotIdentity,
	type OpenPullRequest,
} from '@mng-review/github'
import { ConfigProvider, Effect, FileSystem, Layer, Redacted } from 'effect'
import { RiskRunService } from '../../application/risk-run.service'
import {
	FileSystemLayer,
	cleanupRepos,
} from '../../shared/mocks/git-test.helper'
import { RULES } from '../../shared/mocks/review-report.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { listRiskPulls, runRiskSweepStep } from './risk-sweep-step.handler'

const PULL = {
	number: 17,
	base: {
		sha: 'a'.repeat(40),
		ref: 'main',
		repo: { full_name: 'example/project' },
	},
	head: { sha: 'b'.repeat(40), repo: { full_name: 'example/project' } },
	draft: false,
} as const satisfies OpenPullRequest
const CREATED_AT = '2026-01-01T12:00:00Z'
const RISK_ENV = {
	MNG_REVIEW_APP_ENVIRONMENT: 'review',
	MNG_REVIEW_DEFAULT_BRANCH: 'main',
	MNG_REVIEW_DISPATCH_WORKFLOW: 'review.yml',
} as const
const APP_ENV = {
	MNG_REVIEW_APP_SLUG: 'mng-review',
	MNG_REVIEW_APP_TOKEN: 'app-fixture',
	MNG_REVIEW_MINTED_APP_SLUG: 'mng-review',
} as const

/** The rules with the rating on or off. */
function toRules(enabled: boolean) {
	return {
		...RULES,
		config: { ...RULES.config, risk: { ...RULES.config.risk, enabled } },
	}
}

/** Recorded boundaries for the list of pull requests; nothing can reach an HTTP client. */
function listSetup(
	identity = 'mng-review',
	env: Readonly<Record<string, string>> = RISK_ENV
) {
	const listOpenPullRequestsSpy = vi.fn(() =>
		Effect.succeed([PULL, { ...PULL, number: 18 }])
	)
	const dependencies = Layer.mergeAll(
		Layer.succeed(GitHubConfig, {
			owner: 'example',
			name: 'project',
			apiUrl: 'https://api.example.test',
			graphqlUrl: 'https://api.example.test/graphql',
			serverUrl: 'https://example.test',
			token: Redacted.make('fixture'),
			identity: toBotIdentity(identity),
		}),
		Layer.succeed(GitHubStatusService, {
			listOpenPullRequests: listOpenPullRequestsSpy,
			createCheckRun: () => Effect.die('unexpected check'),
			setStatus: () => Effect.die('unexpected status'),
			getStatus: () => Effect.die('unexpected status read'),
		}),
		ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))
	)
	return { dependencies, listOpenPullRequestsSpy }
}

/** The per-pull-request step over the step fixture, with spies for the thread raise and the sweep. */
function stepSetup(
	riskEnabled = true,
	rateThread: RiskRunService['Service']['rateThread'] = () =>
		Effect.succeed({ status: 'none' }),
	sweepPull: RiskSweepService['Service']['sweepPull'] = input =>
		Effect.succeed({ pullNumber: input.pullNumber, verdict: 'none' })
) {
	const fixture = stepFixture(
		[],
		true,
		false,
		undefined,
		undefined,
		undefined,
		riskEnabled
	)
	fixture.api.command.pullRequest = {
		...fixture.api.command.pullRequest,
		created_at: CREATED_AT,
	}
	const rateThreadSpy = vi.fn(rateThread)
	const sweepPullSpy = vi.fn(sweepPull)
	const layers = Layer.mergeAll(
		fixture.rulesLayer,
		fixture.api.api,
		GitHubWriteConfigLive,
		Layer.succeed(RiskSweepService, { sweepPull: sweepPullSpy }),
		Layer.succeed(RiskRunService, {
			rateThread: rateThreadSpy,
			rateFull: () => Effect.die('unexpected full rating'),
			readAnswers: () => Effect.die('unexpected answer read'),
		})
	)
	const run = (env: Readonly<Record<string, string>> = {}) =>
		runRiskSweepStep.pipe(
			Effect.provide(layers),
			Effect.provide(
				fixture.envLayer({
					...APP_ENV,
					...RISK_ENV,
					MNG_REVIEW_TARGET_PR: '17',
					GITHUB_REPOSITORY_ID: '1',
					...env,
				})
			)
		)
	return { fixture, rateThreadSpy, sweepPullSpy, run }
}

/** The job summary the step wrote. */
const readSummary = (path: string) =>
	FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.readFileString(path)))

afterEach(cleanupRepos)

layer(Layer.empty)('risk sweep pull list', test => {
	for (const scenario of ['off', 'job token'] as const)
		test.effect(`${scenario} lists no pull request for the risk pass`, () =>
			Effect.gen(function* () {
				const fixture = listSetup(
					scenario === 'job token' ? 'github-actions' : 'mng-review'
				)
				expect(
					yield* listRiskPulls(toRules(scenario !== 'off')).pipe(
						Effect.provide(fixture.dependencies)
					)
				).toEqual([])
				expect(fixture.listOpenPullRequestsSpy).not.toHaveBeenCalled()
			})
		)
	test.effect('lists every open pull request for one risk job each', () =>
		Effect.gen(function* () {
			const fixture = listSetup()
			expect(
				yield* listRiskPulls(toRules(true)).pipe(
					Effect.provide(fixture.dependencies)
				)
			).toEqual([17, 18])
		})
	)
})

layer(FileSystemLayer)('risk sweep step for one pull request', test => {
	test.effect(
		'raises the threads and then sweeps only the pull request it was given',
		() =>
			Effect.gen(function* () {
				const step = stepSetup()
				yield* step.run()
				expect(step.rateThreadSpy).toHaveBeenCalledOnce()
				expect(step.rateThreadSpy.mock.calls[0]?.[1]).toMatchObject({
					pullNumber: 17,
					head: PULL.head.sha,
					baseSha: PULL.base.sha,
				})
				expect(step.sweepPullSpy).toHaveBeenCalledExactlyOnceWith({
					pullNumber: 17,
					head: PULL.head.sha,
					since: CREATED_AT,
					repositoryId: 1,
					checks: { review: true, converse: true },
					maxRuns: RULES.config.limits.max_runs_per_pr,
					workflow: 'review.yml',
					defaultBranch: 'main',
				})
				expect(step.rateThreadSpy.mock.invocationCallOrder[0]).toBeLessThan(
					step.sweepPullSpy.mock.invocationCallOrder[0] ?? 0
				)
				expect(step.fixture.loads).toEqual(['HEAD'])
			})
	)
	for (const scenario of ['fork', 'draft', 'other base'] as const)
		test.effect(`${scenario} raises nothing and dispatches nothing`, () =>
			Effect.gen(function* () {
				const step = stepSetup()
				const pull = step.fixture.api.command.pullRequest
				step.fixture.api.command.pullRequest = {
					...pull,
					...(scenario === 'draft' ? { draft: true } : {}),
					...(scenario === 'fork'
						? { head: { ...pull.head, repo: { full_name: 'example/fork' } } }
						: {}),
					...(scenario === 'other base'
						? { base: { ...pull.base, ref: 'release' } }
						: {}),
				}
				yield* step.run()
				expect(step.rateThreadSpy).not.toHaveBeenCalled()
				expect(step.sweepPullSpy.mock.calls[0]?.[0].checks).toEqual({
					review: false,
					converse: false,
				})
			})
		)
	for (const scenario of ['off', 'closed'] as const)
		test.effect(
			`${scenario} reads and writes nothing for the pull request`,
			() =>
				Effect.gen(function* () {
					const step = stepSetup(scenario !== 'off')
					if (scenario === 'closed')
						step.fixture.api.command.pullRequest = {
							...step.fixture.api.command.pullRequest,
							state: 'closed',
						}
					yield* step.run()
					expect(step.rateThreadSpy).not.toHaveBeenCalled()
					expect(step.sweepPullSpy).not.toHaveBeenCalled()
				})
		)
	for (const scenario of [
		'thread raise failed',
		'step 1 failed',
		'sweep read failed',
		'pull request read failed',
	] as const)
		test.effect(`${scenario} fails the job with exit 1`, () =>
			Effect.gen(function* () {
				const step = stepSetup(
					true,
					scenario === 'thread raise failed'
						? () => Effect.succeed({ status: 'failed', reason: 'thread read' })
						: () => Effect.succeed({ status: 'none' }),
					scenario === 'step 1 failed'
						? () =>
								Effect.fail(
									new RiskStepOneError({
										stage: 'held-read',
										reason: 'statuses',
									})
								)
						: scenario === 'sweep read failed'
							? () =>
									Effect.fail(
										new GitHubApiError({
											operation: 'listRuns',
											reason: 'more than 2000 entries',
										})
									)
							: input =>
									Effect.succeed({
										pullNumber: input.pullNumber,
										verdict: 'none',
									})
				)
				if (scenario === 'pull request read failed')
					step.fixture.api.failures.getPullRequest.push(
						new GitHubApiError({
							operation: 'getPullRequest',
							reason: 'unavailable',
							status: 502,
						})
					)
				expect(yield* step.run().pipe(Effect.flip)).toMatchObject({
					_tag: 'ActionExit',
					code: 1,
				})
				expect(yield* readSummary(step.fixture.paths.summary)).toContain(
					'risk sweep'
				)
			})
		)
	for (const scenario of [
		'thread read failed',
		'grant may stand',
		'raised to high',
	] as const)
		test.effect(
			`a written thread check ${scenario === 'raised to high' ? 'passes' : 'fails the job'}: ${scenario}`,
			() =>
				Effect.gen(function* () {
					const step = stepSetup(true, () =>
						Effect.succeed({
							status: 'written',
							result:
								scenario === 'thread read failed'
									? {
											state: 'error',
											level: 'none',
											reason: 'thread-read-failed',
										}
									: {
											state: 'failure',
											level: 'high',
											...(scenario === 'grant may stand'
												? { grantStands: true }
												: {}),
										},
						})
					)
					const outcome = yield* step.run().pipe(Effect.result)
					expect(outcome).toMatchObject(
						scenario === 'raised to high'
							? { _tag: 'Success' }
							: { _tag: 'Failure', failure: { _tag: 'ActionExit', code: 1 } }
					)
					expect(yield* readSummary(step.fixture.paths.summary)).toContain(
						'thread check: written'
					)
					expect(step.sweepPullSpy).toHaveBeenCalledOnce()
				})
		)
	test.effect('the owned identities of the default branch rules apply', () =>
		Effect.gen(function* () {
			const observed: string[] = []
			const step = stepSetup(true, () =>
				OwnedIdentities.pipe(
					Effect.map(owned => {
						observed.push(owned.current.login)
						return { status: 'none' } as const
					})
				)
			)
			yield* step.run()
			expect(observed).toEqual(['mng-review'])
		})
	)
})

layer(FileSystemLayer)('risk sweep step gate and dispatch workflow', test => {
	for (const scenario of ['skip label', 'skipped author'] as const)
		test.effect(
			`a ${scenario} stops the review dispatch the dispatched run would skip, not the converse`,
			() =>
				Effect.gen(function* () {
					const step = stepSetup()
					const pull = step.fixture.api.command.pullRequest
					step.fixture.api.command.pullRequest = {
						...pull,
						...(scenario === 'skip label'
							? { labels: [{ name: RULES.config.skip.labels[0] ?? '' }] }
							: { user: { login: RULES.config.skip.authors[0] ?? '' } }),
					}
					yield* step.run()
					expect(step.sweepPullSpy.mock.calls[0]?.[0].checks).toEqual({
						review: false,
						converse: true,
					})
					expect(step.rateThreadSpy).toHaveBeenCalledOnce()
				})
		)
	for (const verdict of ['none', 'no-workflow'] as const)
		test.effect(
			`without a dispatch workflow the thread raise still runs and ${verdict === 'none' ? 'nothing needed passes' : 'a needed dispatch fails the job'}`,
			() =>
				Effect.gen(function* () {
					const step = stepSetup(true, undefined, input =>
						Effect.succeed({ pullNumber: input.pullNumber, verdict })
					)
					const outcome = yield* step
						.run({ MNG_REVIEW_DISPATCH_WORKFLOW: '' })
						.pipe(Effect.result)
					expect(step.rateThreadSpy).toHaveBeenCalledOnce()
					expect(step.sweepPullSpy.mock.calls[0]?.[0]).not.toHaveProperty(
						'workflow'
					)
					expect(outcome).toMatchObject(
						verdict === 'none'
							? { _tag: 'Success' }
							: { _tag: 'Failure', failure: { _tag: 'ActionExit', code: 1 } }
					)
				})
		)
	test.effect('lists the open pull requests without a dispatch workflow', () =>
		Effect.gen(function* () {
			const fixture = listSetup('mng-review', {
				...RISK_ENV,
				MNG_REVIEW_DISPATCH_WORKFLOW: '',
			})
			expect(
				yield* listRiskPulls(toRules(true)).pipe(
					Effect.provide(fixture.dependencies)
				)
			).toEqual([17, 18])
		})
	)
})
