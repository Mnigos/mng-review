import { layer } from '@effect/vitest'
import { Effect } from 'effect'
import { provideListCompleteness } from '../../../platform/list-completeness.context'
import { readThreadOverHttp } from '../../../shared/mocks/github-http.helper'
import {
	confirmedThread,
	riskFixture,
} from '../../../shared/mocks/github-status-fake.helper'
import { APP_MODE_OWNED } from '../../../shared/mocks/publish-test.helper'
import { RiskReadService } from './risk-read.service'

layer(APP_MODE_OWNED)('RiskReadService thread bugs', test => {
	for (const complete of [true, false])
		test.effect(
			`a null node in a resolved bug's whole thread fails the read with complete=${complete}`,
			() =>
				Effect.gen(function* () {
					const fake = riskFixture()
					fake.threads.push(
						confirmedThread({ resolved: true, unsettled: undefined })
					)
					fake.api.threadReader.read = readThreadOverHttp([null])
					expect(
						yield* RiskReadService.use(service =>
							service.readThreadBugs(17, [])
						).pipe(
							Effect.provide(fake.readLayer),
							provideListCompleteness(complete)
						)
					).toBeUndefined()
				})
		)
	test.effect(
		'a resolved bug whose whole thread holds no unsettled answer does not count',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.threads.push(
					confirmedThread({ resolved: true, unsettled: undefined })
				)
				fake.api.threadReader.read = readThreadOverHttp([])
				expect(
					yield* RiskReadService.use(service =>
						service.readThreadBugs(17, [])
					).pipe(Effect.provide(fake.readLayer))
				).toEqual([])
			})
	)
})
