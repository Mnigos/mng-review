import { layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'
import {
	commandHandlesConfig,
	commandTargetConfig,
	triggerConfig,
} from './command-run.config'

const TARGET_ENV = {
	MNG_REVIEW_TARGET_PR: '17',
	MNG_REVIEW_TARGET_BASE: 'a'.repeat(40),
	MNG_REVIEW_TARGET_HEAD: 'b'.repeat(64),
} as const

/** An isolated environment that never inherits the runner's real variables. */
const environmentLayer = (values: Readonly<Record<string, string>>) =>
	ConfigProvider.layer(ConfigProvider.fromEnvRecord(values))

layer(Layer.empty)('command runner configuration', test => {
	for (const depth of [undefined, '', 'deep', 'quick'])
		for (const agent of [undefined, '', '   ', ' storage '])
			test.effect(
				`reads depth ${JSON.stringify(depth)} and agent ${JSON.stringify(agent)}`,
				() =>
					Effect.gen(function* () {
						expect(
							yield* commandTargetConfig.pipe(
								Effect.provide(
									environmentLayer({
										...TARGET_ENV,
										...(depth === undefined
											? {}
											: { MNG_REVIEW_COMMAND_DEPTH: depth }),
										...(agent === undefined
											? {}
											: { MNG_REVIEW_COMMAND_AGENT: agent }),
									})
								)
							)
						).toEqual({
							pullNumber: 17,
							base: TARGET_ENV.MNG_REVIEW_TARGET_BASE,
							head: TARGET_ENV.MNG_REVIEW_TARGET_HEAD,
							depth: depth || undefined,
							agent: agent?.trim() || undefined,
						})
					})
			)
	for (const [name, value] of [
		['MNG_REVIEW_TARGET_PR', 'seventeen'],
		['MNG_REVIEW_TARGET_PR', '17.5'],
		['MNG_REVIEW_TARGET_BASE', 'a'.repeat(39)],
		['MNG_REVIEW_TARGET_HEAD', 'g'.repeat(40)],
		['MNG_REVIEW_TARGET_HEAD', 'refs/heads/main'],
		['MNG_REVIEW_COMMAND_DEPTH', 'normal'],
		['MNG_REVIEW_COMMAND_DEPTH', 'DEEP'],
		['MNG_REVIEW_COMMAND_DEPTH', ' deep '],
	] as const)
		test.effect(`refuses malformed ${name}=${value}`, () =>
			Effect.gen(function* () {
				expect(
					yield* commandTargetConfig.pipe(
						Effect.provide(environmentLayer({ ...TARGET_ENV, [name]: value })),
						Effect.result
					)
				).toHaveProperty('_tag', 'Failure')
			})
		)
	for (const name of Object.keys(TARGET_ENV))
		test.effect(`requires ${name}`, () =>
			Effect.gen(function* () {
				expect(
					yield* commandTargetConfig.pipe(
						Effect.provide(
							environmentLayer(
								Object.fromEntries(
									Object.entries(TARGET_ENV).filter(([key]) => key !== name)
								)
							)
						),
						Effect.result
					)
				).toHaveProperty('_tag', 'Failure')
			})
		)
	for (const trigger of [undefined, 'push', 'command'])
		test.effect(`reads trigger ${JSON.stringify(trigger)}`, () =>
			Effect.gen(function* () {
				expect(
					yield* triggerConfig.pipe(
						Effect.provide(
							environmentLayer(
								trigger === undefined ? {} : { MNG_REVIEW_TRIGGER: trigger }
							)
						)
					)
				).toBe(trigger ?? 'push')
			})
		)
	for (const trigger of ['manual', 'COMMAND', 'review'])
		test.effect(`refuses trigger ${JSON.stringify(trigger)}`, () =>
			Effect.gen(function* () {
				expect(
					yield* triggerConfig.pipe(
						Effect.provide(environmentLayer({ MNG_REVIEW_TRIGGER: trigger })),
						Effect.result
					)
				).toHaveProperty('_tag', 'Failure')
			})
		)
	test.effect('handle inputs default to empty', () =>
		Effect.gen(function* () {
			expect(
				yield* commandHandlesConfig.pipe(Effect.provide(environmentLayer({})))
			).toEqual({ appSlug: '', handle: '' })
		})
	)
	test.effect('reads both handle inputs without choosing one', () =>
		Effect.gen(function* () {
			expect(
				yield* commandHandlesConfig.pipe(
					Effect.provide(
						environmentLayer({
							MNG_REVIEW_APP_SLUG: 'mng-review',
							MNG_REVIEW_HANDLE: 'review-helper',
						})
					)
				)
			).toEqual({ appSlug: 'mng-review', handle: 'review-helper' })
		})
	)
})
