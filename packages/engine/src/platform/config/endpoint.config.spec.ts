import { layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Redacted } from 'effect'
import {
	EndpointConfig,
	EndpointConfigLive,
	LLM_URL_VARIABLE,
} from './endpoint.config'

layer(Layer.empty)('EndpointConfig', test => {
	for (const url of [
		undefined,
		'',
		'  ',
		'not a URL',
		'file:///tmp/endpoint',
		'ftp://example.test',
	])
		test.effect(
			`rejects missing or invalid URL ${String(url)} without exposing it`,
			() =>
				Effect.gen(function* () {
					const failure = yield* EndpointConfig.pipe(
						Effect.provide(EndpointConfigLive),
						Effect.provide(
							ConfigProvider.layer(
								ConfigProvider.fromEnvRecord(
									url === undefined ? {} : { MNG_REVIEW_LLM_URL: url }
								)
							)
						),
						Effect.flip
					)
					expect(failure).toMatchObject({
						_tag: 'ConfigError',
						source: LLM_URL_VARIABLE,
					})
					if (url?.trim()) expect(failure.message).not.toContain(url)
				})
		)
	test.effect(
		'uses only the supplied environment and retains a redacted optional key',
		() =>
			Effect.gen(function* () {
				const config = yield* EndpointConfig.pipe(
					Effect.provide(EndpointConfigLive),
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnvRecord({
								MNG_REVIEW_LLM_URL: ' https://api.example.test/v1/// ',
								MNG_REVIEW_LLM_KEY: 'fixture-key',
							})
						)
					)
				)
				expect(config.url).toBe('https://api.example.test/v1')
				expect(Redacted.isRedacted(config.key)).toBeTruthy()
				expect(String(config.key)).not.toContain('fixture-key')
				const noKey = yield* EndpointConfig.pipe(
					Effect.provide(EndpointConfigLive),
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnvRecord({
								MNG_REVIEW_LLM_URL: 'http://api.example.test',
							})
						)
					)
				)
				expect(noKey.key).toBeUndefined()
			})
	)
})
