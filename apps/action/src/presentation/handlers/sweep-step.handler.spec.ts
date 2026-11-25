import { layer } from '@effect/vitest'
import { GitError, RulesService } from '@mng-review/engine'
import {
	GitHubApiError,
	GitHubStatusService,
	GitHubWriteConfigLive,
	ListCompleteness,
	OwnedIdentities,
	StatusSweepService,
} from '@mng-review/github'
import { Effect, FileSystem, Layer } from 'effect'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { RiskSweepOffLayer } from '../../shared/mocks/risk-run.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import {
	failSweepConfig,
	RISK_MATRIX_LIMIT,
	runSweepStep,
} from './sweep-step.handler'

const SWEPT = {
	checked: 1,
	updated: 0,
	failed: 0,
} as const
const PULL = {
	number: 17,
	base: {
		sha: 'a'.repeat(40),
		ref: 'main',
		repo: { full_name: 'example/project' },
	},
	head: { sha: 'b'.repeat(40), repo: { full_name: 'example/project' } },
} as const

afterEach(cleanupRepos)

layer(FileSystemLayer)('sweep step app identity', test => {
	for (const previous of [[], ['github-actions']])
		test.effect(
			`loads HEAD rules before sweeping with previous=${previous.join(',')}`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture(previous, true, false, ['release-owner'])
					const observed: string[][] = []
					const sweepSpy = vi.fn(() =>
						OwnedIdentities.pipe(
							Effect.map(owned => {
								observed.push(owned.identities.map(identity => identity.login))
								return {
									checked: 1,
									updated: 1,
									failed: 0,
								}
							})
						)
					)
					yield* runSweepStep.pipe(
						Effect.provide(
							Layer.mergeAll(
								fixture.rulesLayer,
								Layer.succeed(StatusSweepService, { sweep: sweepSpy }),
								RiskSweepOffLayer,
								GitHubWriteConfigLive
							)
						),
						Effect.provide(
							fixture.envLayer({
								MNG_REVIEW_APP_SLUG: 'mng-review',
								MNG_REVIEW_APP_TOKEN: 'app-fixture',
								MNG_REVIEW_MINTED_APP_SLUG: 'mng-review',
							})
						)
					)
					expect(fixture.loads).toEqual(['HEAD'])
					expect(observed).toEqual([['mng-review', ...previous]])
					expect(sweepSpy).toHaveBeenCalledExactlyOnceWith(['release-owner'])
				})
		)
	for (const settings of [
		{ MNG_REVIEW_APP_SLUG: 'mng-review' },
		{ MNG_REVIEW_APP_TOKEN: 'app-fixture' },
		{
			MNG_REVIEW_APP_SLUG: 'mng-review',
			MNG_REVIEW_APP_TOKEN: 'app-fixture',
			MNG_REVIEW_MINTED_APP_SLUG: 'other-app',
		},
	])
		test.effect(
			`broken sweep app settings exit 2 before a request: ${Object.keys(settings).join(',')}`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const sweepSpy = vi.fn(() => Effect.die('must not sweep'))
					expect(
						yield* runSweepStep.pipe(
							Effect.provide(
								Layer.mergeAll(
									fixture.rulesLayer,
									Layer.succeed(StatusSweepService, { sweep: sweepSpy }),
									RiskSweepOffLayer,
									GitHubWriteConfigLive
								)
							),
							Effect.catchTag('ConfigError', failSweepConfig),
							Effect.provide(
								fixture.envLayer(Object.fromEntries(Object.entries(settings)))
							),
							Effect.flip
						)
					).toMatchObject({ _tag: 'ActionExit', code: 2 })
					expect(sweepSpy).not.toHaveBeenCalled()
					expect(fixture.loads).toEqual([])
					expect(fixture.api.writes).toEqual([])
					expect(fixture.status.statuses).toEqual([])
					expect(
						yield* (yield* FileSystem.FileSystem).readFileString(
							fixture.paths.summary
						)
					).toContain('status sweep failed')
				})
		)
	for (const scenario of ['on', 'off', 'list failed'] as const)
		test.effect(
			`hands the risk jobs their pull requests through an output: ${scenario}`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture(
						[],
						true,
						false,
						undefined,
						undefined,
						undefined,
						scenario !== 'off'
					)
					const seen: boolean[] = []
					const sweepSpy = vi.fn(() =>
						ListCompleteness.pipe(
							Effect.map(reading => {
								seen.push(reading.complete)
								return SWEPT
							})
						)
					)
					const listOpenPullRequestsSpy = vi.fn(() =>
						scenario === 'list failed'
							? Effect.fail(
									new GitHubApiError({
										operation: 'listOpenPullRequests',
										reason: 'unavailable',
										status: 502,
									})
								)
							: Effect.succeed([PULL])
					)
					const outcome = yield* runSweepStep.pipe(
						Effect.provide(
							Layer.mergeAll(
								fixture.rulesLayer,
								Layer.succeed(StatusSweepService, { sweep: sweepSpy }),
								Layer.succeed(GitHubStatusService, {
									listOpenPullRequests: listOpenPullRequestsSpy,
									createCheckRun: () => Effect.die('unexpected check'),
									setStatus: () => Effect.die('unexpected status'),
									getStatus: () => Effect.die('unexpected status read'),
								}),
								GitHubWriteConfigLive
							)
						),
						Effect.provide(
							fixture.envLayer({
								MNG_REVIEW_APP_SLUG: 'mng-review',
								MNG_REVIEW_APP_TOKEN: 'app-fixture',
								MNG_REVIEW_MINTED_APP_SLUG: 'mng-review',
								MNG_REVIEW_APP_ENVIRONMENT: 'review',
								MNG_REVIEW_DEFAULT_BRANCH: 'main',
								MNG_REVIEW_DISPATCH_WORKFLOW: 'review.yml',
							})
						),
						Effect.result
					)
					expect(sweepSpy).toHaveBeenCalledOnce()
					// Only rules that rate read complete lists; a null node fails such a pull request.
					expect(seen).toEqual([scenario !== 'off'])
					const fs = yield* FileSystem.FileSystem
					if (scenario === 'list failed') {
						expect(outcome).toMatchObject({
							_tag: 'Failure',
							failure: { _tag: 'ActionExit', code: 1 },
						})
						expect(yield* fs.readFileString(fixture.paths.summary)).toContain(
							'risk pass failed'
						)
						return
					}
					expect(outcome._tag).toBe('Success')
					expect(yield* fs.readFileString(fixture.paths.output)).toBe(
						`risk-pulls=${scenario === 'on' ? '[17]' : '[]'}\n`
					)
				})
		)
})

/** The open list's options as the sweep passes them. */
interface ListOptions {
	readonly complete?: boolean
}

/** Open pull requests numbered from 1, as many as asked. */
function getPulls(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		...PULL,
		number: index + 1,
	}))
}

/** One open pull request as `getPulls` numbers it. */
type ListedPull = ReturnType<typeof getPulls>[number]

/** Runs the sweep with the rating on and the open list the spy answers. */
const runRatedSweep = (
	listOpenPullRequestsSpy: (
		options?: ListOptions
	) => Effect.Effect<readonly ListedPull[], GitHubApiError>
) =>
	Effect.gen(function* () {
		const fixture = stepFixture(
			[],
			true,
			false,
			undefined,
			undefined,
			undefined,
			true
		)
		const outcome = yield* runSweepStep.pipe(
			Effect.provide(
				Layer.mergeAll(
					fixture.rulesLayer,
					Layer.succeed(StatusSweepService, {
						sweep: () => Effect.succeed(SWEPT),
					}),
					Layer.succeed(GitHubStatusService, {
						listOpenPullRequests: listOpenPullRequestsSpy,
						createCheckRun: () => Effect.die('unexpected check'),
						setStatus: () => Effect.die('unexpected status'),
						getStatus: () => Effect.die('unexpected status read'),
					}),
					GitHubWriteConfigLive
				)
			),
			Effect.provide(
				fixture.envLayer({
					MNG_REVIEW_APP_SLUG: 'mng-review',
					MNG_REVIEW_APP_TOKEN: 'app-fixture',
					MNG_REVIEW_MINTED_APP_SLUG: 'mng-review',
					MNG_REVIEW_APP_ENVIRONMENT: 'review',
					MNG_REVIEW_DEFAULT_BRANCH: 'main',
					MNG_REVIEW_DISPATCH_WORKFLOW: 'review.yml',
				})
			),
			Effect.result
		)
		const fs = yield* FileSystem.FileSystem
		return {
			outcome,
			summary: yield* fs.readFileString(fixture.paths.summary),
			output: yield* fs
				.readFileString(fixture.paths.output)
				.pipe(Effect.orElseSucceed(() => '')),
		}
	})

layer(FileSystemLayer)('sweep step risk list limits', test => {
	test.effect(
		'an open list cut short at its page limit fails the sweep and hands out no pull request',
		() =>
			Effect.gen(function* () {
				const listOpenPullRequestsSpy = vi.fn((options?: ListOptions) =>
					options?.complete
						? Effect.fail(
								new GitHubApiError({
									operation: 'listOpenPullRequests',
									reason: 'more than 2000 entries',
								})
							)
						: Effect.succeed(getPulls(2000))
				)
				const swept = yield* runRatedSweep(listOpenPullRequestsSpy)
				expect(listOpenPullRequestsSpy).toHaveBeenCalledExactlyOnceWith({
					complete: true,
				})
				expect(swept.outcome).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'ActionExit', code: 1 },
				})
				expect(swept.summary).toContain('more than 2000 entries')
				expect(swept.output).not.toContain('risk-pulls')
			})
	)
	for (const count of [RISK_MATRIX_LIMIT, RISK_MATRIX_LIMIT + 1])
		test.effect(
			`${count} open pull requests ${count > RISK_MATRIX_LIMIT ? 'fail the sweep past the matrix cap' : 'fit one matrix'}`,
			() =>
				Effect.gen(function* () {
					const pulls = getPulls(count)
					const swept = yield* runRatedSweep(() => Effect.succeed(pulls))
					if (count <= RISK_MATRIX_LIMIT) {
						expect(swept.outcome._tag).toBe('Success')
						expect(swept.output).toBe(
							`risk-pulls=${JSON.stringify(pulls.map(pr => pr.number))}\n`
						)
						return
					}
					expect(swept.outcome).toMatchObject({
						_tag: 'Failure',
						failure: { _tag: 'ActionExit', code: 1 },
					})
					expect(swept.summary).toContain(
						`${count} open pull requests, more than the ${RISK_MATRIX_LIMIT} jobs`
					)
					expect(swept.output).not.toContain('risk-pulls')
				})
		)
})

layer(FileSystemLayer)('sweep step rules that do not load', test => {
	for (const rating of [true, false])
		test.effect(
			`a git error loading the rules ${rating ? 'fails the sweep when the settings would rate' : 'passes without the app settings'}`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture([], true)
					const outcome = yield* runSweepStep.pipe(
						Effect.provide(
							Layer.mergeAll(
								Layer.succeed(RulesService, {
									load: () =>
										Effect.fail(
											new GitError({
												args: ['show'],
												exitCode: 128,
												stderr: 'missing commit',
											})
										),
								}),
								Layer.succeed(StatusSweepService, {
									sweep: () => Effect.die('must not sweep'),
								}),
								RiskSweepOffLayer,
								GitHubWriteConfigLive
							)
						),
						Effect.provide(
							fixture.envLayer({
								MNG_REVIEW_APP_SLUG: 'mng-review',
								MNG_REVIEW_APP_TOKEN: 'app-fixture',
								MNG_REVIEW_MINTED_APP_SLUG: 'mng-review',
								...(rating
									? {
											MNG_REVIEW_APP_ENVIRONMENT: 'review',
											MNG_REVIEW_DEFAULT_BRANCH: 'main',
										}
									: {}),
							})
						),
						Effect.result
					)
					expect(outcome).toMatchObject(
						rating
							? { _tag: 'Failure', failure: { _tag: 'ActionExit', code: 1 } }
							: { _tag: 'Success' }
					)
					const fs = yield* FileSystem.FileSystem
					expect(yield* fs.readFileString(fixture.paths.summary)).toContain(
						'missing commit'
					)
					expect(
						yield* fs
							.readFileString(fixture.paths.output)
							.pipe(Effect.orElseSucceed(() => ''))
					).toBe(rating ? '' : 'risk-pulls=[]\n')
				})
		)
})
