import { inspect } from 'node:util'
import { OpenAiLanguageModel } from '@effect/ai-openai-compat'
import { layer } from '@effect/vitest'
import {
	Clock,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Redacted,
	Schema,
	Tracer,
} from 'effect'
import { LanguageModel, Tool, Toolkit } from 'effect/ai'
import {
	HttpClient,
	HttpClientError,
	type HttpClientRequest,
	HttpClientResponse,
} from 'effect/http'
import { TestClock } from 'effect/testing'
import { EndpointConfig } from '../config/endpoint.config'
import { LLM_CALL_TIMEOUT, LLM_RETRY_DELAY_MILLIS } from './llm.constants'
import { LlmService, LlmServiceLive, LlmSettings } from './llm.service'
import { TokenLedger, TokenLedgerLive } from './token-ledger.service'

const ENDPOINT = 'https://api.example.test/v1'
const FIXTURE_CREDENTIAL = 'fixture-credential-value'
const MODEL = { model: 'model-a', effort: 'high' } as const
const DEFAULT_USAGE = {
	prompt_tokens: 7,
	completion_tokens: 3,
	total_tokens: 10,
	completion_tokens_details: { reasoning_tokens: 1 },
} as const
const METERED = {
	calls: 1,
	inputTokens: 7,
	cachedInputTokens: 0,
	outputTokens: 3,
	reasoningTokens: 1,
	totalTokens: 10,
} as const
const generate = LanguageModel.generateText({
	prompt: [
		{ role: 'system', content: 'System instructions.' },
		{ role: 'user', content: 'Hello' },
	],
})

/** OpenAI-compatible completion, built afresh so response bodies are never reused. */
function completion(
	usage: unknown = DEFAULT_USAGE,
	model: string | null = 'provider-model'
) {
	return Response.json({
		id: 'fixture',
		object: 'chat.completion',
		created: 0,
		...(model === null ? {} : { model }),
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content: 'done' },
				finish_reason: 'stop',
			},
		],
		...(usage === null ? {} : { usage }),
	})
}

type Reply = (
	request: HttpClientRequest.HttpClientRequest,
	index: number
) => Effect.Effect<Response, HttpClientError.HttpClientError>
interface HarnessOptions {
	readonly concurrency?: number
	readonly credential?: string
}

/** Replaces HTTP transport completely; no request leaves this process. */
function harness(reply: Reply, options: HarnessOptions = {}) {
	const requests: HttpClientRequest.HttpClientRequest[] = []
	const starts: number[] = []
	const client = HttpClient.make(request =>
		Effect.gen(function* () {
			const index = requests.length
			requests.push(request)
			starts.push(yield* Clock.currentTimeMillis)
			return HttpClientResponse.fromWeb(request, yield* reply(request, index))
		})
	)
	const liveLayer = LlmServiceLive.pipe(
		Layer.provideMerge(TokenLedgerLive),
		Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
		Layer.provide(
			Layer.succeed(EndpointConfig, {
				url: ENDPOINT,
				key:
					options.credential === undefined
						? undefined
						: Redacted.make(options.credential),
			})
		),
		Layer.provide(
			Layer.succeed(LlmSettings, { concurrency: options.concurrency ?? 2 })
		)
	)
	return { layer: liveLayer, requests, starts }
}

/** Keeps complete native spans, including error exits and event attributes, for leak assertions. */
function recordingTracer() {
	const spans: Tracer.NativeSpan[] = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, layer: Layer.succeed(Tracer.Tracer, tracer) }
}

layer(Layer.empty)('LlmService HTTP', test => {
	for (const toolChoice of [
		'required',
		'auto',
		'none',
		{ tool: 'route' },
	] as const)
		test.effect(
			`serializes model, effort, messages, tools and choice ${JSON.stringify(toolChoice)}`,
			() =>
				Effect.gen(function* () {
					const http = harness(() => Effect.succeed(completion()), {
						credential: ` ${FIXTURE_CREDENTIAL} `,
					})
					const route = Tool.make('route', {
						description: 'Route',
						parameters: Schema.Struct({ risk: Schema.String }),
						success: Schema.Void,
					})
					yield* Effect.gen(function* () {
						const response = yield* LlmService.use(llm =>
							llm.run(
								MODEL,
								LanguageModel.generateText({
									prompt: [
										{ role: 'system', content: 'System instructions.' },
										{ role: 'user', content: 'Hello' },
									],
									toolkit: Toolkit.make(route),
									toolChoice,
									disableToolCallResolution: true,
								}).pipe(
									OpenAiLanguageModel.withConfigOverride({
										max_completion_tokens: 123,
									})
								)
							)
						)
						expect(response.text).toBe('done')
						expect(response.usage.inputTokens.total).toBe(7)
						expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toEqual({
							'model-a': METERED,
						})
					}).pipe(Effect.provide(http.layer))
					expect(http.requests).toHaveLength(1)
					const [request] = http.requests
					expect(request?.url).toBe(`${ENDPOINT}/chat/completions`)
					expect(request?.method).toBe('POST')
					expect(request?.headers.authorization).toBe(
						`Bearer ${FIXTURE_CREDENTIAL}`
					)
					expect(request?.headers['content-type']).toContain('application/json')
					expect(request?.body._tag).toBe('Uint8Array')
					if (request?.body._tag === 'Uint8Array')
						expect(
							JSON.parse(new TextDecoder().decode(request.body.body))
						).toMatchObject({
							model: MODEL.model,
							reasoning_effort: MODEL.effort,
							max_completion_tokens: 123,
							messages: [
								{ role: 'system', content: 'System instructions.' },
								{ role: 'user', content: 'Hello' },
							],
							tools: [{ type: 'function', function: { name: 'route' } }],
							tool_choice:
								typeof toolChoice === 'string'
									? toolChoice
									: { type: 'function', function: { name: 'route' } },
						})
				})
		)
	for (const credential of [undefined, '', '  '])
		test.effect(
			`omits authorization when credential is absent or blank: ${String(credential)}`,
			() =>
				Effect.gen(function* () {
					const http = harness(
						() => Effect.succeed(completion()),
						credential === undefined ? {} : { credential }
					)
					yield* LlmService.use(llm => llm.run(MODEL, generate)).pipe(
						Effect.provide(http.layer)
					)
					expect(http.requests[0]?.headers.authorization).toBeUndefined()
				})
		)
	for (const status of [429, 500, 502, 503])
		test.effect(
			`retries ${status} exactly once after the default delay and counts only success`,
			() =>
				Effect.gen(function* () {
					const http = harness((_request, index) =>
						Effect.succeed(
							index === 0 ? new Response('busy', { status }) : completion()
						)
					)
					yield* Effect.gen(function* () {
						const llm = yield* LlmService
						const fiber = yield* llm.run(MODEL, generate).pipe(Effect.forkChild)
						yield* TestClock.adjust(LLM_RETRY_DELAY_MILLIS - 1)
						expect(http.requests).toHaveLength(1)
						yield* TestClock.adjust(1)
						expect((yield* Fiber.join(fiber)).text).toBe('done')
						expect(http.requests).toHaveLength(2)
						expect(http.starts[1]).toBe(
							(http.starts[0] ?? 0) + LLM_RETRY_DELAY_MILLIS
						)
						expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toEqual({
							'model-a': METERED,
						})
					}).pipe(Effect.provide(http.layer))
				})
		)
	for (const status of [429, 500, 503])
		test.effect(`makes no third request after repeated ${status}`, () =>
			Effect.gen(function* () {
				const http = harness(() =>
					Effect.succeed(new Response('still unavailable', { status }))
				)
				yield* Effect.gen(function* () {
					const fiber = yield* LlmService.use(llm =>
						llm.run(MODEL, generate)
					).pipe(Effect.flip, Effect.forkChild)
					yield* TestClock.adjust(LLM_RETRY_DELAY_MILLIS)
					expect(yield* Fiber.join(fiber)).toMatchObject({
						_tag: 'LlmError',
						status,
					})
					expect(http.requests).toHaveLength(2)
					expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toEqual({})
				}).pipe(Effect.provide(http.layer))
			})
		)
	for (const status of [400, 401, 403, 404, 408, 422])
		test.effect(
			`does not retry ${status} and redacts provider error details`,
			() =>
				Effect.gen(function* () {
					const http = harness(
						() =>
							Effect.succeed(
								Response.json(
									{
										error: {
											message: `Rejected ${FIXTURE_CREDENTIAL} at ${ENDPOINT} or api.example.test and https://other.example.test/path`,
											type: 'fixture',
										},
									},
									{ status }
								)
							),
						{ credential: FIXTURE_CREDENTIAL }
					)
					const failure = yield* LlmService.use(llm =>
						llm.run(MODEL, generate)
					).pipe(Effect.provide(http.layer), Effect.flip)
					expect(failure).toMatchObject({ _tag: 'LlmError', status })
					expect(http.requests).toHaveLength(1)
					for (const secret of [
						FIXTURE_CREDENTIAL,
						ENDPOINT,
						'api.example.test',
						'https://other.example.test/path',
					])
						expect(failure.message).not.toContain(secret)
				})
		)
	for (const status of [429, 503])
		for (const retryAfter of ['0.02', '30', '3600'])
			test.effect(
				retryAfter === '0.02'
					? `uses the default delay for fractional Retry-After on ${status}`
					: `honors Retry-After ${retryAfter} on ${status}, caps waits at thirty seconds`,
				() =>
					Effect.gen(function* () {
						const http = harness((_request, index) =>
							Effect.succeed(
								index === 0
									? new Response('busy', {
											status,
											headers: { 'Retry-After': retryAfter },
										})
									: completion()
							)
						)
						yield* Effect.gen(function* () {
							const fiber = yield* LlmService.use(llm =>
								llm.run(MODEL, generate)
							).pipe(Effect.exit, Effect.forkChild)
							yield* TestClock.adjust(30_001)
							const outcome = yield* Fiber.join(fiber)
							if (Number(retryAfter) > 30) {
								expect(Exit.isFailure(outcome)).toBeTruthy()
								expect(http.requests).toHaveLength(1)
							} else {
								expect(Exit.isSuccess(outcome)).toBeTruthy()
								expect(http.requests).toHaveLength(2)
								expect((http.starts[1] ?? 0) - (http.starts[0] ?? 0)).toBe(
									retryAfter === '0.02'
										? LLM_RETRY_DELAY_MILLIS
										: Number(retryAfter) * 1000
								)
							}
						}).pipe(Effect.provide(http.layer))
					})
			)
	for (const retryAfter of [
		undefined,
		'invalid',
		'-1',
		'Thu, 01 Jan 1970 00:00:10 GMT',
		'Wed, 31 Dec 1969 23:59:59 GMT',
	])
		test.effect(
			`Retry-After fallback, dates and negative values: ${String(retryAfter)}`,
			() =>
				Effect.gen(function* () {
					yield* TestClock.setTime(0)
					const http = harness((_request, index) =>
						Effect.succeed(
							index === 0
								? new Response('busy', {
										status: 429,
										headers:
											retryAfter === undefined
												? {}
												: { 'Retry-After': retryAfter },
									})
								: completion()
						)
					)
					yield* Effect.gen(function* () {
						const fiber = yield* LlmService.use(llm =>
							llm.run(MODEL, generate)
						).pipe(Effect.forkChild)
						yield* TestClock.adjust(30_000)
						yield* Fiber.join(fiber)
						const expected =
							retryAfter === undefined ||
							retryAfter === 'invalid' ||
							retryAfter === '-1'
								? LLM_RETRY_DELAY_MILLIS
								: retryAfter.startsWith('Thu')
									? 10_000
									: 0
						expect((http.starts[1] ?? 0) - (http.starts[0] ?? 0)).toBe(expected)
					}).pipe(Effect.provide(http.layer))
				})
		)
	test.effect(
		'times out a pending HTTP call without retrying and cancels transport',
		() =>
			Effect.gen(function* () {
				const cancelled = yield* Deferred.make<void>()
				const http = harness(() =>
					Effect.never.pipe(
						Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined))
					)
				)
				yield* Effect.gen(function* () {
					const fiber = yield* LlmService.use(llm =>
						llm.run(MODEL, generate)
					).pipe(Effect.flip, Effect.forkChild)
					yield* TestClock.adjust(LLM_CALL_TIMEOUT)
					expect(yield* Fiber.join(fiber)).toMatchObject({
						_tag: 'LlmError',
						reason: 'Timeout',
						retryable: false,
					})
					expect(http.requests).toHaveLength(1)
					yield* Deferred.await(cancelled)
					expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toEqual({})
				}).pipe(Effect.provide(http.layer))
			})
	)
	test.effect(
		'caller interruption cancels transport and releases its permit',
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const cancelled = yield* Deferred.make<void>()
				const http = harness(
					(_request, index) =>
						index === 0
							? Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.onInterrupt(() =>
										Deferred.succeed(cancelled, undefined)
									)
								)
							: Effect.succeed(completion()),
					{ concurrency: 1 }
				)
				yield* Effect.gen(function* () {
					const llm = yield* LlmService
					const fiber = yield* llm.run(MODEL, generate).pipe(Effect.forkChild)
					yield* Deferred.await(entered)
					yield* Fiber.interrupt(fiber)
					yield* Deferred.await(cancelled)
					expect((yield* llm.run(MODEL, generate)).text).toBe('done')
					expect(http.requests).toHaveLength(2)
				}).pipe(Effect.provide(http.layer))
			})
	)
	for (const body of [
		'not JSON',
		{},
		{ choices: [] },
		{ choices: [{ message: { content: 42 } }] },
	])
		test.effect(
			`rejects invalid JSON or response shape without retry or token accounting: ${JSON.stringify(body)}`,
			() =>
				Effect.gen(function* () {
					const http = harness(() =>
						Effect.succeed(
							typeof body === 'string'
								? new Response(body)
								: Response.json(body)
						)
					)
					yield* Effect.gen(function* () {
						expect(
							yield* LlmService.use(llm => llm.run(MODEL, generate)).pipe(
								Effect.flip
							)
						).toMatchObject({ _tag: 'LlmError' })
						expect(http.requests).toHaveLength(1)
						expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toEqual(
							{}
						)
					}).pipe(Effect.provide(http.layer))
				})
		)
	for (const choices of [
		[],
		[
			{
				index: 0,
				message: { role: 'assistant', content: 42 },
				finish_reason: 'stop',
			},
		],
	])
		test.effect(
			choices.length === 0
				? 'accepts empty choices and records usage without text or tool calls'
				: `rejects malformed choices on an otherwise complete response: ${JSON.stringify(choices)}`,
			() =>
				Effect.gen(function* () {
					const http = harness(() =>
						Effect.succeed(
							Response.json({
								id: 'fixture',
								object: 'chat.completion',
								created: 0,
								model: 'provider-model',
								choices,
								usage: DEFAULT_USAGE,
							})
						)
					)
					yield* Effect.gen(function* () {
						if (choices.length === 0) {
							const response = yield* LlmService.use(llm =>
								llm.run(MODEL, generate)
							)
							expect(response.text).toBe('')
							expect(response.toolCalls).toEqual([])
							expect(http.requests).toHaveLength(1)
							expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toEqual(
								{
									'model-a': METERED,
								}
							)
							return
						}
						expect(
							yield* LlmService.use(llm => llm.run(MODEL, generate)).pipe(
								Effect.flip
							)
						).toMatchObject({ _tag: 'LlmError' })
						expect(http.requests).toHaveLength(1)
						expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toEqual(
							{}
						)
					}).pipe(Effect.provide(http.layer))
				})
		)
	test.effect('maps raw HTTP tool calls through effect/ai', () =>
		Effect.gen(function* () {
			const http = harness(() =>
				Effect.succeed(
					Response.json({
						id: 'fixture',
						object: 'chat.completion',
						created: 0,
						model: 'provider-model',
						choices: [
							{
								index: 0,
								message: {
									role: 'assistant',
									content: null,
									tool_calls: [
										{
											id: 'call-1',
											type: 'function',
											function: {
												name: 'route',
												arguments: '{"risk":"normal"}',
											},
										},
									],
								},
								finish_reason: 'tool_calls',
							},
						],
						usage: DEFAULT_USAGE,
					})
				)
			)
			const route = Tool.make('route', {
				parameters: Schema.Struct({ risk: Schema.String }),
				success: Schema.Void,
			})
			const response = yield* LlmService.use(llm =>
				llm.run(
					MODEL,
					LanguageModel.generateText({
						prompt: 'Route.',
						toolkit: Toolkit.make(route),
						toolChoice: { tool: 'route' },
						disableToolCallResolution: true,
					})
				)
			).pipe(Effect.provide(http.layer))
			expect(response.toolCalls).toMatchObject([
				{ id: 'call-1', name: 'route', params: { risk: 'normal' } },
			])
		})
	)

	for (const status of [400, 200])
		test.effect(
			status === 400
				? 'records only a redacted outer span when the provider echoes credentials and endpoint details'
				: 'records no provider or HTTP spans for a successful call',
			() =>
				Effect.gen(function* () {
					const endpoint = new URL(ENDPOINT)
					const http = harness(
						() =>
							Effect.succeed(
								status === 400
									? Response.json(
											{
												error: {
													message: `Rejected ${FIXTURE_CREDENTIAL} ${ENDPOINT} ${endpoint.origin} ${endpoint.host}`,
													type: 'invalid_request_error',
												},
											},
											{ status }
										)
									: completion()
							),
						{ credential: FIXTURE_CREDENTIAL }
					)
					const recording = recordingTracer()
					const outcome = yield* LlmService.use(llm =>
						llm.run(MODEL, generate)
					).pipe(
						Effect.exit,
						Effect.provide(http.layer),
						Effect.provide(recording.layer)
					)
					expect(http.requests).toHaveLength(1)
					expect(recording.spans.map(span => span.name)).toEqual(
						status === 400
							? ['LlmService.run']
							: ['LlmService.run', 'TokenLedger.record']
					)
					const outer = recording.spans.find(
						span => span.name === 'LlmService.run'
					)
					expect(outer?.attributes).toEqual(
						new Map([
							['model', MODEL.model],
							['effort', MODEL.effort],
						])
					)
					expect(outer?.status).toMatchObject({ _tag: 'Ended', exit: outcome })
					if (status === 400)
						expect(Exit.findErrorOption(outcome)).toMatchObject({
							_tag: 'Some',
							value: { _tag: 'LlmError', status: 400, retryable: false },
						})
					else expect(Exit.isSuccess(outcome)).toBeTruthy()
					for (const span of recording.spans) {
						const recorded = inspect(
							{
								name: span.name,
								attributes: span.attributes,
								events: span.events,
								status: span.status,
							},
							{
								depth: null,
								showHidden: true,
								customInspect: false,
								maxArrayLength: null,
								maxStringLength: null,
							}
						)
						for (const secret of [
							FIXTURE_CREDENTIAL,
							ENDPOINT,
							endpoint.origin,
							endpoint.host,
						])
							expect(recorded).not.toContain(secret)
					}
				})
		)

	test.effect(
		'rejects a missing provider model without retry and redacts the error',
		() =>
			Effect.gen(function* () {
				const http = harness(
					() => Effect.succeed(completion(DEFAULT_USAGE, null)),
					{ credential: FIXTURE_CREDENTIAL }
				)
				const failure = yield* LlmService.use(llm =>
					llm.run(MODEL, generate)
				).pipe(Effect.provide(http.layer), Effect.flip)
				expect(failure).toMatchObject({ _tag: 'LlmError', retryable: false })
				expect(http.requests).toHaveLength(1)
				for (const secret of [FIXTURE_CREDENTIAL, ENDPOINT, 'api.example.test'])
					expect(failure.message).not.toContain(secret)
				expect(failure.message).not.toMatch(/https?:\/\//u)
			})
	)

	test.effect(
		'transport failures normalize and redact credentials, URLs, origins and bare hosts',
		() =>
			Effect.gen(function* () {
				const http = harness(
					request =>
						Effect.fail(
							new HttpClientError.HttpClientError({
								reason: new HttpClientError.TransportError({
									request,
									description: `Failed ${FIXTURE_CREDENTIAL} ${ENDPOINT} https://api.example.test api.example.test https://other.example.test`,
								}),
							})
						),
					{ credential: FIXTURE_CREDENTIAL }
				)
				const failure = yield* LlmService.use(llm =>
					llm.run(MODEL, generate)
				).pipe(Effect.provide(http.layer), Effect.flip)
				expect(failure).toMatchObject({ _tag: 'LlmError' })
				expect(http.requests).toHaveLength(1)
				for (const secret of [
					FIXTURE_CREDENTIAL,
					ENDPOINT,
					'api.example.test',
					'https://other.example.test',
				])
					expect(failure.message).not.toContain(secret)
			})
	)
	test.effect(
		'response-body stream errors normalize and redact like transport failures',
		() =>
			Effect.gen(function* () {
				const http = harness(
					() =>
						Effect.succeed(
							new Response(
								new ReadableStream({
									start(controller) {
										controller.error(
											new Error(
												`body failed ${FIXTURE_CREDENTIAL} ${ENDPOINT} api.example.test https://other.example.test`
											)
										)
									},
								})
							)
						),
					{ credential: FIXTURE_CREDENTIAL }
				)
				const failure = yield* LlmService.use(llm =>
					llm.run(MODEL, generate)
				).pipe(Effect.provide(http.layer), Effect.flip)
				expect(failure).toMatchObject({ _tag: 'LlmError' })
				expect(http.requests).toHaveLength(1)
				for (const secret of [
					FIXTURE_CREDENTIAL,
					ENDPOINT,
					'api.example.test',
					'https://other.example.test',
				])
					expect(failure.message).not.toContain(secret)
			})
	)
	test.effect(
		'accumulates usage under requested model names, sums totals and isolates snapshots',
		() =>
			Effect.gen(function* () {
				const http = harness(() =>
					Effect.succeed(
						completion({
							prompt_tokens: 4,
							completion_tokens: 2,
							total_tokens: 6,
						})
					)
				)
				yield* Effect.gen(function* () {
					const llm = yield* LlmService
					const ledger = yield* TokenLedger
					yield* llm.run(MODEL, generate)
					const snapshot = yield* ledger.snapshot
					yield* llm.run(MODEL, generate)
					yield* llm.run({ ...MODEL, model: 'model-b' }, generate)
					expect(yield* ledger.snapshot).toEqual({
						'model-a': {
							calls: 2,
							inputTokens: 8,
							cachedInputTokens: 0,
							outputTokens: 4,
							reasoningTokens: 0,
							totalTokens: 12,
						},
						'model-b': {
							calls: 1,
							inputTokens: 4,
							cachedInputTokens: 0,
							outputTokens: 2,
							reasoningTokens: 0,
							totalTokens: 6,
						},
					})
					expect(snapshot['model-a']?.calls).toBe(1)
				}).pipe(Effect.provide(http.layer))
			})
	)
	test.effect(
		'rejects missing total_tokens without retry, token accounting or endpoint details',
		() =>
			Effect.gen(function* () {
				const http = harness(
					() =>
						Effect.succeed(
							completion({ prompt_tokens: 4, completion_tokens: 2 })
						),
					{ credential: FIXTURE_CREDENTIAL }
				)
				yield* Effect.gen(function* () {
					const failure = yield* LlmService.use(llm =>
						llm.run(MODEL, generate)
					).pipe(Effect.flip)
					expect(failure).toMatchObject({ _tag: 'LlmError', retryable: false })
					expect(http.requests).toHaveLength(1)
					for (const secret of [
						FIXTURE_CREDENTIAL,
						ENDPOINT,
						'api.example.test',
					])
						expect(failure.message).not.toContain(secret)
					expect(failure.message).not.toMatch(/https?:\/\//u)
					expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toEqual({})
				}).pipe(Effect.provide(http.layer))
			})
	)
	test.effect('missing usage still records a call with zero counts', () =>
		Effect.gen(function* () {
			const http = harness(() => Effect.succeed(completion(null)))
			yield* Effect.gen(function* () {
				yield* LlmService.use(llm => llm.run(MODEL, generate))
				expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toEqual({
					'model-a': {
						calls: 1,
						inputTokens: 0,
						cachedInputTokens: 0,
						outputTokens: 0,
						reasoningTokens: 0,
						totalTokens: 0,
					},
				})
			}).pipe(Effect.provide(http.layer))
		})
	)
	test.effect(
		'bounds in-flight requests and releases slots after failures',
		() =>
			Effect.gen(function* () {
				const entered = yield* Effect.all([
					Deferred.make<void>(),
					Deferred.make<void>(),
					Deferred.make<void>(),
					Deferred.make<void>(),
					Deferred.make<void>(),
				] as const)
				const release = yield* Effect.all([
					Deferred.make<void>(),
					Deferred.make<void>(),
					Deferred.make<void>(),
					Deferred.make<void>(),
					Deferred.make<void>(),
				] as const)
				const active: number[] = []
				const peaks: number[] = []
				const http = harness(
					(_request, index) =>
						Effect.gen(function* () {
							const enteredGate = entered[index]
							const releaseGate = release[index]
							if (enteredGate === undefined || releaseGate === undefined)
								return yield* Effect.die('unexpected extra HTTP request')
							active.push(index)
							peaks.push(active.length)
							yield* Deferred.succeed(enteredGate, undefined)
							yield* Deferred.await(releaseGate)
							active.splice(active.indexOf(index), 1)
							return index === 0
								? new Response('bad request', { status: 400 })
								: completion()
						}),
					{ concurrency: 2 }
				)
				yield* Effect.gen(function* () {
					const llm = yield* LlmService
					const fiber = yield* Effect.forEach(
						[0, 1, 2, 3, 4],
						() => llm.run(MODEL, generate).pipe(Effect.exit),
						{ concurrency: 'unbounded' }
					).pipe(Effect.forkChild)
					yield* Deferred.await(entered[0])
					yield* Deferred.await(entered[1])
					expect(http.requests).toHaveLength(2)
					expect(active).toHaveLength(2)
					yield* Deferred.succeed(release[0], undefined)
					yield* Deferred.await(entered[2])
					expect(active).toHaveLength(2)
					yield* Deferred.succeed(release[1], undefined)
					yield* Deferred.await(entered[3])
					yield* Deferred.succeed(release[2], undefined)
					yield* Deferred.await(entered[4])
					yield* Effect.all(
						release.map(gate => Deferred.succeed(gate, undefined))
					)
					const outcomes = yield* Fiber.join(fiber)
					expect(outcomes.map(outcome => Exit.isSuccess(outcome))).toEqual([
						false,
						true,
						true,
						true,
						true,
					])
					expect(Math.max(...peaks)).toBe(2)
					expect(active).toEqual([])
				}).pipe(Effect.provide(http.layer))
			})
	)
})

layer(Layer.empty)('cached endpoint usage', test => {
	test.effect('maps prompt cache-read usage to cachedInputTokens', () =>
		Effect.gen(function* () {
			const http = harness(() =>
				Effect.succeed(
					completion({
						...DEFAULT_USAGE,
						prompt_tokens_details: { cached_tokens: 4 },
					})
				)
			)
			yield* Effect.gen(function* () {
				yield* LlmService.use(llm => llm.run(MODEL, generate))
				expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toEqual({
					'model-a': { ...METERED, cachedInputTokens: 4 },
				})
			}).pipe(Effect.provide(http.layer))
		})
	)
})
