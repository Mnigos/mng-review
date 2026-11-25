import { layer } from '@effect/vitest'
import {
	GitHubApiError,
	GitHubWriteConfigLive,
	type RaiseResult,
	ListCompleteness,
	OwnedIdentities,
	RaiseService,
} from '@mng-review/github'
import { Effect, FileSystem, Layer } from 'effect'
import { TestConsole } from 'effect/testing'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { failRaiseConfig, runRaiseStep } from './raise-step.handler'

/** The app's settings in the raise job's environment, with the target from the find job. */
const APP_SETTINGS = {
	MNG_REVIEW_APP_SLUG: 'mng-review',
	MNG_REVIEW_APP_TOKEN: 'app-fixture',
	MNG_REVIEW_MINTED_APP_SLUG: 'mng-review',
	MNG_REVIEW_TARGET_PR: '17',
} as const

/** The `success` a raise writes. */
const READY = { state: 'success', description: 'no open bug thread' } as const

afterEach(cleanupRepos)

/** Runs the raise step over a raise service that answers `raise`. */
function runRaise(
	fixture: ReturnType<typeof stepFixture>,
	raise: RaiseService['Service']['raise'],
	settings: Readonly<Record<string, string>> = APP_SETTINGS
) {
	return runRaiseStep.pipe(
		Effect.provide(
			Layer.mergeAll(
				fixture.rulesLayer,
				Layer.succeed(RaiseService, {
					findDue: () => Effect.die('the raise job never lists'),
					raise,
				}),
				GitHubWriteConfigLive
			)
		),
		Effect.catchTag('ConfigError', failRaiseConfig),
		Effect.provide(fixture.envLayer(settings))
	)
}

layer(FileSystemLayer)('raise step', test => {
	for (const [outcome, line] of [
		[
			'raised',
			'raise on #17: success written, 1 change request(s) dismissed, 0 not dismissed',
		],
		[
			'not-due',
			'raise on #17: nothing to raise; something still blocks or nothing is left to raise',
		],
		[
			'incomplete',
			'raise on #17: a list GitHub returned was incomplete, so nothing was raised',
		],
		[
			'moved',
			'raise on #17: the head moved before the writes, so nothing was raised',
		],
		[
			'changed',
			'raise on #17: the status changed since the judgment, so nothing was raised',
		],
		['closed', 'raise on #17: the pull request is closed'],
	] as const)
		test.effect(`a ${outcome} raise passes and says so`, () =>
			Effect.gen(function* () {
				const fixture = stepFixture(['github-actions'], true, false, [
					'release-owner',
				])
				const observed: string[][] = []
				const raiseSpy = vi.fn(
					(_pullNumber: number, _allow: readonly string[]) =>
						OwnedIdentities.pipe(
							Effect.map((owned): RaiseResult => {
								observed.push(owned.identities.map(identity => identity.login))
								return {
									outcome,
									...(outcome === 'closed' ? {} : { head: 'head' }),
									...(outcome === 'raised' ? { status: READY } : {}),
									dismissal: {
										dismissed: outcome === 'raised' ? 1 : 0,
										failed: 0,
									},
								}
							})
						)
				)
				yield* runRaise(fixture, raiseSpy)
				expect(fixture.loads).toEqual(['HEAD'])
				expect(raiseSpy).toHaveBeenCalledExactlyOnceWith(17, ['release-owner'])
				expect(observed).toEqual([['mng-review', 'github-actions']])
				expect(yield* TestConsole.logLines).toEqual([`mng-review: ${line}`])
				expect(
					yield* (yield* FileSystem.FileSystem).readFileString(
						fixture.paths.summary
					)
				).toContain('## MNG Review (raise)')
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
		)
	test.effect('a read GitHub refuses fails the step with exit 1', () =>
		Effect.gen(function* () {
			const fixture = stepFixture()
			expect(
				yield* runRaise(fixture, () =>
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
				'mng-review: raise failed: GitHub listReviewThreads failed (HTTP 503): unavailable',
			])
		}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect('a missing target exits 2 before any raise', () =>
		Effect.gen(function* () {
			const fixture = stepFixture()
			const raiseSpy = vi.fn(() => Effect.die('must not raise'))
			const { MNG_REVIEW_TARGET_PR: _target, ...settings } = APP_SETTINGS
			expect(
				yield* runRaise(fixture, raiseSpy, settings).pipe(Effect.flip)
			).toMatchObject({ _tag: 'ActionExit', code: 2 })
			expect(raiseSpy).not.toHaveBeenCalled()
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
					yield* runRaise(fixture, () =>
						ListCompleteness.pipe(
							Effect.map((reading): RaiseResult => {
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
