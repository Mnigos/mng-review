import { layer } from '@effect/vitest'
import {
	GitHubWriteConfigLive,
	OwnedIdentities,
	StatusSweepService,
} from '@mng-review/github'
import { Effect, FileSystem, Layer } from 'effect'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { failSweepConfig, runSweepStep } from './sweep-step.handler'

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
								return { checked: 1, updated: 1, failed: 0 }
							})
						)
					)
					yield* runSweepStep.pipe(
						Effect.provide(
							Layer.mergeAll(
								fixture.rulesLayer,
								Layer.succeed(StatusSweepService, { sweep: sweepSpy }),
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
})
