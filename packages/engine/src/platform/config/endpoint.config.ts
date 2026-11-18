import { ConfigError } from '@mng-review/domain'
import { Config, Context, Effect, Layer, Option, type Redacted } from 'effect'

export const LLM_URL_VARIABLE = 'MNG_REVIEW_LLM_URL'
export const LLM_KEY_VARIABLE = 'MNG_REVIEW_LLM_KEY'
const HTTP_PROTOCOLS = ['http:', 'https:'] as const

/** The OpenAI-compatible endpoint every model role talks to. */
export class EndpointConfig extends Context.Service<
	EndpointConfig,
	{
		/** Base URL such as `https://host/v1`, without a trailing slash. */
		readonly url: string
		/** Unset for an endpoint that needs no key. */
		readonly key: Redacted.Redacted | undefined
	}
>()('mng-review/EndpointConfig') {}

/** The URL without trailing slashes, or the reason it is not an http(s) URL. */
function toEndpointUrl(raw: string): string | ConfigError {
	const url = raw.trim().replace(/\/+$/u, '')
	const parsed = URL.canParse(url) ? new URL(url) : undefined
	if (!parsed)
		return new ConfigError({
			source: LLM_URL_VARIABLE,
			reason: 'not a valid URL',
		})
	if (!HTTP_PROTOCOLS.some(protocol => protocol === parsed.protocol))
		return new ConfigError({
			source: LLM_URL_VARIABLE,
			reason: 'must be an http or https URL',
		})
	return url
}

/**
 * `MNG_REVIEW_LLM_URL` is required; `MNG_REVIEW_LLM_KEY` is optional and stays redacted until the
 * client is built. An unset, empty or malformed URL fails with a `ConfigError` naming the variable;
 * the URL itself never appears in the message.
 */
export const EndpointConfigLive = Layer.effect(
	EndpointConfig,
	Effect.gen(function* () {
		const settings = yield* Config.all({
			url: Config.option(Config.String('MNG_REVIEW_LLM_URL')),
			key: Config.option(Config.Redacted('MNG_REVIEW_LLM_KEY')),
		}).pipe(
			Effect.mapError(
				() =>
					new ConfigError({
						source: `${LLM_URL_VARIABLE} or ${LLM_KEY_VARIABLE}`,
						reason: 'could not be read',
					})
			)
		)
		const raw = Option.getOrUndefined(settings.url)?.trim()
		if (!raw)
			return yield* new ConfigError({
				source: LLM_URL_VARIABLE,
				reason: 'is not set',
			})
		const url = toEndpointUrl(raw)
		if (url instanceof ConfigError) return yield* url
		return { url, key: Option.getOrUndefined(settings.key) }
	})
)
