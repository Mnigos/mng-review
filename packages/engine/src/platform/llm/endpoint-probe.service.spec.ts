import { layer } from '@effect/vitest'
import { ConfigProvider, Deferred, Effect, Fiber, Layer } from 'effect'
import {
	HttpClient,
	HttpClientError,
	type HttpClientRequest,
	HttpClientResponse,
} from 'effect/http'
import { TestClock } from 'effect/testing'
import {
	EndpointProbeService,
	EndpointProbeServiceLive,
	type EndpointProbe,
} from './endpoint-probe.service'
import { PROBE_TIMEOUT } from './llm.constants'

const ENDPOINT = 'https://llm.example.com/v1'
const CREDENTIAL = 'test-key'
const ENVIRONMENT = {
	MNG_REVIEW_LLM_URL: ENDPOINT,
	MNG_REVIEW_LLM_KEY: CREDENTIAL,
} as const satisfies Record<string, string>
type Reply = (
	request: HttpClientRequest.HttpClientRequest
) => Effect.Effect<Response, HttpClientError.HttpClientError>

/** A scripted transport captures requests without opening a connection. */
function harness(reply: Reply, env: Record<string, string> = ENVIRONMENT) {
	const requests: HttpClientRequest.HttpClientRequest[] = []
	const client = HttpClient.make(request =>
		Effect.gen(function* () {
			requests.push(request)
			return HttpClientResponse.fromWeb(request, yield* reply(request))
		})
	)
	const probe = EndpointProbeService.use(service => service.probe()).pipe(
		Effect.provide(EndpointProbeServiceLive),
		Effect.provideService(HttpClient.HttpClient, client),
		Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))
	)
	return { probe, requests }
}

/** An offline explanation must not echo transport diagnostics or credentials. */
function expectPrivateReason(outcome: EndpointProbe) {
	expect(outcome.status).toBe('offline')
	if (outcome.status !== 'offline') return
	for (const value of [ENDPOINT, 'llm.example.com', CREDENTIAL])
		expect(outcome.reason).not.toContain(value)
	expect(outcome.reason.length).toBeGreaterThan(0)
}

layer(Layer.empty)('EndpointProbeService', test => {
	for (const status of [200, 201, 204, 299, 400, 404, 405, 408, 422])
		test.effect(`HTTP ${status} is online`, () =>
			Effect.gen(function* () {
				const fixture = harness(() =>
					Effect.succeed(new Response(null, { status }))
				)
				expect(yield* fixture.probe).toEqual({ status: 'online' })
				expect(fixture.requests).toHaveLength(1)
				expect(fixture.requests[0]).toMatchObject({
					method: 'GET',
					url: `${ENDPOINT}/models`,
					headers: { authorization: `Bearer ${CREDENTIAL}` },
				})
			})
		)
	for (const status of [401, 403, 429, 500, 502, 503, 599])
		test.effect(`HTTP ${status} is offline with a private reason`, () =>
			Effect.gen(function* () {
				const outcome = yield* harness(() =>
					Effect.succeed(new Response(null, { status }))
				).probe
				expectPrivateReason(outcome)
				if (outcome.status === 'offline')
					expect(outcome.reason).toContain(String(status))
			})
		)
	for (const url of [
		undefined,
		'',
		'not a URL',
		`ftp://llm.example.com/${CREDENTIAL}`,
	])
		test.effect(
			`missing or malformed URL ${String(url)} never sends HTTP`,
			() =>
				Effect.gen(function* () {
					const fixture = harness(
						() => Effect.die('HTTP must not run'),
						url === undefined ? {} : { MNG_REVIEW_LLM_URL: url }
					)
					expectPrivateReason(yield* fixture.probe)
					expect(fixture.requests).toEqual([])
				})
		)
	for (const key of [undefined, '', '   '])
		test.effect(`omits authorization for ${String(key)} key`, () =>
			Effect.gen(function* () {
				const fixture = harness(
					() => Effect.succeed(new Response(null, { status: 200 })),
					{
						MNG_REVIEW_LLM_URL: `${ENDPOINT}///`,
						...(key === undefined ? {} : { MNG_REVIEW_LLM_KEY: key }),
					}
				)
				expect(yield* fixture.probe).toEqual({ status: 'online' })
				expect(fixture.requests[0]?.headers).not.toHaveProperty('authorization')
				expect(fixture.requests[0]?.url).toBe(`${ENDPOINT}/models`)
			})
		)
	test.effect('trims a configured key before sending the bearer header', () =>
		Effect.gen(function* () {
			const fixture = harness(
				() => Effect.succeed(new Response(null, { status: 200 })),
				{
					MNG_REVIEW_LLM_URL: ENDPOINT,
					MNG_REVIEW_LLM_KEY: `  ${CREDENTIAL}  `,
				}
			)
			expect(yield* fixture.probe).toEqual({ status: 'online' })
			expect(fixture.requests[0]?.headers.authorization).toBe(
				`Bearer ${CREDENTIAL}`
			)
		})
	)

	test.effect(
		'transport errors discard diagnostics containing the endpoint and key',
		() =>
			Effect.gen(function* () {
				expectPrivateReason(
					yield* harness(request =>
						Effect.fail(
							new HttpClientError.HttpClientError({
								reason: new HttpClientError.TransportError({
									request,
									cause: `${ENDPOINT} ${CREDENTIAL}`,
								}),
							})
						)
					).probe
				)
			})
	)
	test.effect(
		'times out on the test clock and interrupts the pending request',
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const interrupted = yield* Deferred.make<void>()
				const fixture = harness(() =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
					)
				)
				const fiber = yield* fixture.probe.pipe(Effect.forkChild)
				yield* Deferred.await(started)
				yield* TestClock.adjust(PROBE_TIMEOUT)
				const outcome = yield* Fiber.join(fiber)
				expectPrivateReason(outcome)
				if (outcome.status === 'offline')
					expect(outcome.reason).toContain(PROBE_TIMEOUT)
				expect(yield* Deferred.isDone(interrupted)).toBe(true)
			})
	)
})
