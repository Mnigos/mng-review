import { Context, Effect, Layer, Redacted } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { EndpointConfig, EndpointConfigLive } from '../config/endpoint.config'
import { PROBE_TIMEOUT } from './llm.constants'

/** The endpoint answered, or the reason a review should not start. The reason never names the URL. */
export type EndpointProbe =
	| { readonly status: 'online' }
	| { readonly status: 'offline'; readonly reason: string }

const UNAUTHORIZED_STATUSES = [401, 403] as const
const RATE_LIMITED_STATUS = 429
const SERVER_ERROR_STATUS = 500

/** Why a status keeps the review from starting: a refused key, a rate limit or a server error. */
function getOfflineReason(status: number): string | undefined {
	if (UNAUTHORIZED_STATUSES.some(code => code === status))
		return `the key was refused (HTTP ${status})`
	if (status === RATE_LIMITED_STATUS) return `rate limited (HTTP ${status})`
	if (status >= SERVER_ERROR_STATUS) return `server error (HTTP ${status})`
	return undefined
}

/**
 * Asks the endpoint for its models (`GET /models`) before a review starts. Offline: no usable
 * `MNG_REVIEW_LLM_URL`, no answer within `PROBE_TIMEOUT`, a network failure, 401, 403, 429 or a
 * 5xx. Any other answer, a 404 from an endpoint without `/models` included, counts as online.
 */
export class EndpointProbeService extends Context.Service<
	EndpointProbeService,
	{ readonly probe: () => Effect.Effect<EndpointProbe> }
>()('mng-review/EndpointProbeService') {}

export const EndpointProbeServiceLive = Layer.effect(
	EndpointProbeService,
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient

		const request = Effect.fn('EndpointProbeService.request')(function* () {
			const endpoint = yield* EndpointConfig
			const base = HttpClientRequest.get(`${endpoint.url}/models`)
			const key = endpoint.key ? Redacted.value(endpoint.key).trim() : ''
			const response = yield* client.execute(
				key ? HttpClientRequest.bearerToken(base, key) : base
			)
			const reason = getOfflineReason(response.status)
			return reason === undefined
				? ({ status: 'online' } as const)
				: ({ status: 'offline', reason } as const)
		})

		const probe = Effect.fn('EndpointProbeService.probe')(function* () {
			return yield* request().pipe(
				Effect.provide(EndpointConfigLive),
				Effect.timeout(PROBE_TIMEOUT),
				Effect.catchTags({
					ConfigError: error =>
						Effect.succeed({
							status: 'offline',
							reason: `endpoint not configured: ${error.message}`,
						} as const),
					HttpClientError: () =>
						Effect.succeed({
							status: 'offline',
							reason: 'unreachable',
						} as const),
					TimeoutError: () =>
						Effect.succeed({
							status: 'offline',
							reason: `no answer within ${PROBE_TIMEOUT}`,
						} as const),
				}),
				// The HTTP span would record the endpoint's address.
				Effect.withTracerEnabled(false)
			)
		})

		return { probe }
	})
)
