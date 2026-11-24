import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { layer } from '@effect/vitest'
import { getFloorReport, BUILT_IN_FLOOR } from '@mng-review/domain'
import { Effect, Layer, Result } from 'effect'
import { cleanupRepos, gitLayer } from '../../../shared/mocks/git-test.helper'
import { riskRepo } from '../../../shared/mocks/risk-test.helper'
import { FloorDiffService, FloorDiffServiceLive } from './floor-diff.service'

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })('FloorDiffService', test => {
	test.effect(
		'a rename counts at the old and new paths without rename detection',
		() =>
			Effect.gen(function* () {
				const repo = riskRepo('.github/check.yml')
				mkdirSync(join(repo.root, 'destination'))
				repo.git('mv', '.github/check.yml', 'destination/check.yml')
				const head = repo.commit()
				const diff = yield* FloorDiffService.use(service =>
					service.read({ base: repo.head, head })
				).pipe(
					Effect.provide(
						FloorDiffServiceLive.pipe(Layer.provide(gitLayer(repo.root)))
					)
				)
				expect(diff.intact).toBeTruthy()
				expect(
					getFloorReport(diff, {
						floors: [
							{
								name: 'destination',
								paths: ['destination/**'],
								exclude: [],
								level: 'medium',
							},
						],
						assets: [],
						rulesPaths: [],
					}).hits
				).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							name: BUILT_IN_FLOOR.GITHUB,
							paths: ['.github/check.yml'],
							added: 0,
							deleted: 1,
						}),
						expect.objectContaining({
							name: 'destination',
							paths: ['destination/check.yml'],
							added: 1,
							deleted: 0,
						}),
					])
				)
			})
	)
	test.effect('an invalid git range fails the floor read', () =>
		Effect.gen(function* () {
			const repo = riskRepo()
			const read = yield* FloorDiffService.use(service =>
				service.read({ base: 'missing', head: repo.head })
			).pipe(
				Effect.provide(
					FloorDiffServiceLive.pipe(Layer.provide(gitLayer(repo.root)))
				),
				Effect.result
			)
			expect(Result.isFailure(read)).toBeTruthy()
			if (Result.isFailure(read))
				expect(read.failure).toMatchObject({ _tag: 'GitError', exitCode: 128 })
		})
	)
})
