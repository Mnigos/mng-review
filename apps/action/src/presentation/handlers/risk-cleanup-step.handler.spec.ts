import { layer } from '@effect/vitest'
import {
	ConfigError,
	DEFAULT_RISK_LABELS,
	toRiskDescription,
} from '@mng-review/domain'
import { RulesService } from '@mng-review/engine'
import { GitHubConfig, RiskFinishService } from '@mng-review/github'
import { ConfigProvider, Effect, Layer } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The brief requires shared GitHub settings.
import { GITHUB_SETTINGS } from '../../../../../packages/github/src/shared/mocks/github-http.helper'
// oxlint-disable-next-line no-restricted-imports -- The brief requires shared risk fixtures.
import {
	RISK_DESCRIPTION,
	RISK_RULES,
	RISK_HEAD,
	RISK_BASE,
} from '../../../../../packages/github/src/shared/mocks/github-status-fake.helper'
import {
	runRiskCleanupStep,
	failRiskCleanupConfig,
} from './risk-cleanup-step.handler'

layer(Layer.empty)('risk cleanup step', test => {
	for (const scenario of [
		'high',
		'missing',
		'malformed',
		'other pull',
		'rules fail',
	] as const)
		test.effect(
			`${scenario} preserves the step-one maximum or writes no status`,
			() =>
				Effect.gen(function* () {
					const description = { ...RISK_DESCRIPTION, level: 'high' } as const
					const revokeHeadSpy = vi.fn<
						RiskFinishService['Service']['revokeHead']
					>(() =>
						Effect.succeed({
							state:
								scenario === 'high' || scenario === 'rules fail'
									? 'error'
									: 'none',
							level: 'high',
							reason: 'publish-failed',
						})
					)
					const services = Layer.mergeAll(
						Layer.succeed(GitHubConfig, GITHUB_SETTINGS),
						Layer.succeed(RulesService, {
							load: () =>
								scenario === 'rules fail'
									? Effect.fail(
											new ConfigError({ source: 'rules', reason: 'missing' })
										)
									: Effect.succeed(RISK_RULES),
						}),
						Layer.succeed(RiskFinishService, {
							finish: () => Effect.die('unexpected finish'),
							revoke: () => Effect.die('unexpected revoke'),
							revokeHead: revokeHeadSpy,
						}),
						ConfigProvider.layer(
							ConfigProvider.fromEnvRecord({
								MNG_REVIEW_TARGET_PR: '17',
								MNG_REVIEW_TARGET_BASE: RISK_BASE,
								MNG_REVIEW_TARGET_HEAD: RISK_HEAD,
								...(scenario === 'missing'
									? {}
									: {
											MNG_REVIEW_RISK_DESCRIPTION:
												scenario === 'malformed'
													? 'v1 pr=17 high'
													: toRiskDescription({
															...description,
															...(scenario === 'other pull' ? { pr: 18 } : {}),
														}),
										}),
							})
						)
					)
					yield* runRiskCleanupStep.pipe(Effect.provide(services))
					expect(revokeHeadSpy).toHaveBeenCalledOnce()
					expect(revokeHeadSpy.mock.calls[0]?.[0]).toEqual({
						pullNumber: 17,
						head: RISK_HEAD,
						labels: DEFAULT_RISK_LABELS,
						...(scenario === 'high' || scenario === 'rules fail'
							? { description }
							: {}),
					})
				})
		)
	test.effect('invalid configuration exits 2', () =>
		Effect.gen(function* () {
			expect(
				yield* failRiskCleanupConfig({ message: 'missing target' }).pipe(
					Effect.flip
				)
			).toMatchObject({ _tag: 'ActionExit', code: 2 })
		})
	)
})
