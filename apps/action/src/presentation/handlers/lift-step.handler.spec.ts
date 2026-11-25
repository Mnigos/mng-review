import { layer } from '@effect/vitest'
import {
	GitHubApiError,
	GitHubWriteConfigLive,
	type LiftResult,
	ListCompleteness,
	OwnedIdentities,
	RequestLiftService,
} from '@mng-review/github'
import { Effect, FileSystem, Layer } from 'effect'
import { TestConsole } from 'effect/testing'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { failLiftConfig, runLiftStep } from './lift-step.handler'

/** The app's settings in the lift job's environment, with the target from the find job. */
const APP_SETTINGS = {
	MNG_REVIEW_APP_SLUG: 'mng-review',
	MNG_REVIEW_APP_TOKEN: 'app-fixture',
	MNG_REVIEW_MINTED_APP_SLUG: 'mng-review',
	MNG_REVIEW_TARGET_PR: '17',
} as const

afterEach(cleanupRepos)

/** Runs the lift step over a lift service that answers `lift`. */
function runLift(
	fixture: ReturnType<typeof stepFixture>,
	lift: RequestLiftService['Service']['lift'],
	settings: Readonly<Record<string, string>> = APP_SETTINGS
) {
	return runLiftStep.pipe(
		Effect.provide(
			Layer.mergeAll(
				fixture.rulesLayer,
				Layer.succeed(RequestLiftService, {
					findDue: () => Effect.die('the lift job never lists'),
					lift,
				}),
				GitHubWriteConfigLive
			)
		),
		Effect.catchTag('ConfigError', failLiftConfig),
		Effect.provide(fixture.envLayer(settings))
	)
}

layer(FileSystemLayer)('lift step', test => {
	for (const [outcome, line] of [
		[
			'lifted',
			'change request lift on #17: 1 change request(s) dismissed, 0 not dismissed',
		],
		[
			'not-due',
			'change request lift on #17: nothing to dismiss; a change request is still backed or none is left',
		],
		[
			'incomplete',
			'change request lift on #17: a list GitHub returned was incomplete, so nothing was dismissed',
		],
		[
			'moved',
			'change request lift on #17: the head moved before the dismissal, so nothing was dismissed',
		],
		['closed', 'change request lift on #17: the pull request is closed'],
	] as const)
		test.effect(`a ${outcome} lift passes and says so`, () =>
			Effect.gen(function* () {
				const fixture = stepFixture(['github-actions'], true, false, [
					'release-owner',
				])
				const observed: string[][] = []
				const liftSpy = vi.fn(
					(_pullNumber: number, _allow: readonly string[]) =>
						OwnedIdentities.pipe(
							Effect.map((owned): LiftResult => {
								observed.push(owned.identities.map(identity => identity.login))
								return {
									outcome,
									...(outcome === 'closed' ? {} : { head: 'head' }),
									dismissal: {
										dismissed: outcome === 'lifted' ? 1 : 0,
										failed: 0,
									},
								}
							})
						)
				)
				yield* runLift(fixture, liftSpy)
				expect(fixture.loads).toEqual(['HEAD'])
				expect(liftSpy).toHaveBeenCalledExactlyOnceWith(17, ['release-owner'])
				expect(observed).toEqual([['mng-review', 'github-actions']])
				expect(yield* TestConsole.logLines).toEqual([`mng-review: ${line}`])
				expect(
					yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.summary
					)
				).toContain('## MNG Review (change request lift)')
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
		)
	test.effect('a read GitHub refuses fails the step with exit 1', () =>
		Effect.gen(function* () {
			const fixture = stepFixture()
			expect(
				yield* runLift(fixture, () =>
					Effect.fail(
						new GitHubApiError({
							operation: 'listReviewThreads',
							reason: 'unavailable',
							status: 503,
						})
					)
				).pipe(Effect.flip)
			).toMatchObject({ _tag: 'ActionExit', code: 1 })
			expect(yield* TestConsole.logLines).toEqual([
				'mng-review: change request lift failed: GitHub listReviewThreads failed (HTTP 503): unavailable',
			])
		}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect('a missing target exits 2 before any lift', () =>
		Effect.gen(function* () {
			const fixture = stepFixture()
			const liftSpy = vi.fn(() => Effect.die('must not lift'))
			const { MNG_REVIEW_TARGET_PR: _target, ...settings } = APP_SETTINGS
			expect(
				yield* runLift(fixture, liftSpy, settings).pipe(Effect.flip)
			).toMatchObject({ _tag: 'ActionExit', code: 2 })
			expect(liftSpy).not.toHaveBeenCalled()
		})
	)
	for (const riskEnabled of [false, true])
		test.effect(
			`reads complete lists only while the rules rate: ${riskEnabled}`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture(
						undefined,
						false,
						false,
						undefined,
						undefined,
						undefined,
						riskEnabled
					)
					const seen: boolean[] = []
					yield* runLift(fixture, () =>
						ListCompleteness.pipe(
							Effect.map((reading): LiftResult => {
								seen.push(reading.complete)
								return {
									outcome: 'not-due',
									head: 'head',
									dismissal: { dismissed: 0, failed: 0 },
								}
							})
						)
					)
					expect(seen).toEqual([riskEnabled])
				})
		)
})
