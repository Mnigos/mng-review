import { layer } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Result } from 'effect'
import { AiError, LanguageModel } from 'effect/ai'
import { LlmError } from '../../../../platform/llm/llm.errors'
import {
	makeScriptedLlmLayer,
	ScriptedLlm,
	type ScriptedLlmAnswer,
} from '../../../../platform/llm/scripted-llm.layer'
import {
	TokenLedger,
	TokenLedgerLive,
} from '../../../../platform/llm/token-ledger.service'
import { providerError } from '../../../../shared/mocks/review-layer.helper'
import {
	FINISH,
	LIMITS,
	MODEL,
} from '../../../../shared/mocks/review-test.helper'
import { ReviewLimits } from '../review-limits.context'
import {
	getDropReason,
	ModelHealthService,
	ModelHealthServiceLive,
} from './model-health.service'

const generate = LanguageModel.generateText({ prompt: 'Review the fixture.' })

/** Exposes the ledger and captured requests while exercising the real call gate. */
function healthLayer(
	script: ScriptedLlmAnswer,
	limits: Partial<ReviewLimits['Service']> = {}
) {
	return ModelHealthServiceLive.pipe(
		Layer.provideMerge(makeScriptedLlmLayer(script)),
		Layer.provideMerge(TokenLedgerLive),
		Layer.provide(Layer.succeed(ReviewLimits, { ...LIMITS, ...limits }))
	)
}

describe('getDropReason', () => {
	test.each([
		[429, 'RateLimitError', 'fixture', 'rate limited (429)'],
		[503, 'InternalProviderError', 'fixture', 'unavailable (503)'],
		[404, 'InvalidRequestError', 'fixture', 'unknown model (404)'],
		[400, 'InvalidRequestError', 'model_not_found', 'unknown model (400)'],
		[422, 'InvalidRequestError', 'model does not exist', 'unknown model (422)'],
		[500, 'InternalProviderError', 'model unavailable', undefined],
		[400, 'InvalidRequestError', 'invalid messages', undefined],
		[422, 'InvalidRequestError', 'model requires a parameter', undefined],
		[
			400,
			'InvalidRequestError',
			'invalid model parameter: temperature',
			undefined,
		],
		[
			400,
			'InvalidRequestError',
			'model parameter top_k is not supported',
			undefined,
		],
	])('status %s with %s and %s', (status, reason, detail, expected) => {
		expect(
			getDropReason(
				new LlmError({
					model: MODEL.model,
					status,
					reason,
					detail,
					retryable: false,
				})
			)
		).toBe(expected)
	})
})

layer(Layer.empty)('ModelHealthService unknown models', test => {
	for (const [status, detail] of [
		[400, 'Unknown MODEL model-a'],
		[400, 'no such model model-a'],
		[422, 'invalid model model-a'],
	] as const)
		test.effect(`unknown model ${detail} drops and refuses later calls`, () =>
			Effect.gen(function* () {
				const health = yield* ModelHealthService
				expect(
					yield* health.run(MODEL, generate).pipe(Effect.flip)
				).toMatchObject({ _tag: 'ModelDroppedError', model: MODEL.model })
				expect(yield* health.isAvailable(MODEL.model)).toBe(false)
				expect(
					yield* health.run(MODEL, generate).pipe(Effect.flip)
				).toMatchObject({ _tag: 'ModelDroppedError' })
				expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(1)
			}).pipe(
				Effect.provide(
					healthLayer(() => Effect.fail(providerError(status, detail)))
				)
			)
		)
	test.effect('provider error without an HTTP status retains the model', () =>
		Effect.gen(function* () {
			const health = yield* ModelHealthService
			expect(
				yield* health.run(MODEL, generate).pipe(Effect.flip)
			).toMatchObject({ _tag: 'LlmError' })
			expect(yield* health.isAvailable(MODEL.model)).toBe(true)
			expect(yield* health.dropped).toEqual([])
			yield* health.run(MODEL, generate)
			expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(2)
		}).pipe(
			Effect.provide(
				healthLayer((_call, index) =>
					index === 0
						? Effect.fail(
								new AiError.AiError({
									module: 'fixture',
									method: 'generateText',
									reason: new AiError.UnknownError({
										description: 'unknown model',
									}),
								})
							)
						: Effect.succeed([FINISH])
				)
			)
		)
	)
})

layer(Layer.empty)('ModelHealthService', test => {
	for (const status of [429, 503, 404, 400])
		test.effect(
			`drops ${status}, refuses later calls and retains other models`,
			() =>
				Effect.gen(function* () {
					const health = yield* ModelHealthService
					expect(yield* health.isAvailable(MODEL.model)).toBe(true)
					expect(
						yield* health.run(MODEL, generate).pipe(Effect.flip)
					).toMatchObject({ _tag: 'ModelDroppedError', model: MODEL.model })
					expect(yield* health.isAvailable(MODEL.model)).toBe(false)
					expect(
						yield* health.run(MODEL, generate).pipe(Effect.flip)
					).toMatchObject({ _tag: 'ModelDroppedError' })
					yield* health.run({ ...MODEL, model: 'other' }, generate)
					expect(
						(yield* ScriptedLlm.use(script => script.calls)).map(
							call => call.model.model
						)
					).toEqual([MODEL.model, 'other'])
					expect(yield* health.dropped).toEqual([
						{
							model: MODEL.model,
							reason:
								status === 429
									? 'rate limited (429)'
									: status === 503
										? 'unavailable (503)'
										: `unknown model (${status})`,
						},
					])
					expect(
						yield* TokenLedger.use(ledger => ledger.snapshot)
					).toMatchObject({ other: { totalTokens: 5, calls: 1 } })
				}).pipe(
					Effect.provide(
						healthLayer((_call, index) =>
							index === 0
								? Effect.fail(providerError(status, 'model_not_found'))
								: Effect.succeed([FINISH])
						)
					)
				)
		)
	for (const status of [400, 500, 422])
		test.effect(`keeps model after a non-dropping ${status} failure`, () =>
			Effect.gen(function* () {
				const health = yield* ModelHealthService
				expect(
					yield* health.run(MODEL, generate).pipe(Effect.flip)
				).toMatchObject({ _tag: 'LlmError' })
				expect(yield* health.isAvailable(MODEL.model)).toBe(true)
				yield* health.run(MODEL, generate)
				expect(yield* health.dropped).toEqual([])
				expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(2)
			}).pipe(
				Effect.provide(
					healthLayer((_call, index) =>
						index === 0
							? Effect.fail(providerError(status))
							: Effect.succeed([FINISH])
					)
				)
			)
		)
	test.effect('a fresh tracker can use a model dropped in another run', () =>
		Effect.gen(function* () {
			yield* ModelHealthService.use(health => health.run(MODEL, generate)).pipe(
				Effect.flip,
				Effect.provide(healthLayer(() => Effect.fail(providerError(429))))
			)
			expect(
				yield* ModelHealthService.use(health =>
					health.run(MODEL, generate)
				).pipe(Effect.provide(healthLayer(() => Effect.succeed([FINISH]))))
			).toMatchObject({ usage: { inputTokens: { total: 3 } } })
		})
	)
	test.effect('queued calls check the budget only when their slot opens', () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			yield* Effect.gen(function* () {
				const health = yield* ModelHealthService
				const pending = yield* Effect.forEach(
					Array.from({ length: 8 }),
					() => Effect.result(health.run(MODEL, generate)),
					{ concurrency: 'unbounded' }
				).pipe(Effect.forkChild)
				yield* Deferred.await(entered)
				expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(1)
				yield* Deferred.succeed(release, undefined)
				const responses = yield* Fiber.join(pending)
				expect(responses.filter(Result.isSuccess)).toHaveLength(1)
				expect(
					responses.filter(Result.isFailure).map(entry => entry.failure._tag)
				).toEqual(Array.from({ length: 7 }, () => 'TokenBudgetError'))
				expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(1)
				expect(yield* health.dropped).toEqual([])
			}).pipe(
				Effect.provide(
					healthLayer(
						() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.as([FINISH])
							),
						{ tokensPerRun: 5 }
					)
				)
			)
		})
	)
	test.effect(
		'a call may cross the budget; subsequent calls across models are refused',
		() =>
			Effect.gen(function* () {
				const health = yield* ModelHealthService
				yield* health.run(MODEL, generate)
				yield* health.run({ ...MODEL, model: 'other' }, generate)
				expect(
					yield* health.run(MODEL, generate).pipe(Effect.flip)
				).toMatchObject({ _tag: 'TokenBudgetError', spent: 10, limit: 6 })
				expect(yield* TokenLedger.use(ledger => ledger.snapshot)).toMatchObject(
					{ 'model-a': { totalTokens: 5 }, other: { totalTokens: 5 } }
				)
				expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(2)
			}).pipe(
				Effect.provide(
					healthLayer(() => Effect.succeed([FINISH]), { tokensPerRun: 6 })
				)
			)
	)
	test.effect(
		'a ledger exhausted by routing refuses the first finder call',
		() =>
			Effect.gen(function* () {
				yield* TokenLedger.use(ledger =>
					ledger.record('router', {
						inputTokens: { total: 3 },
						outputTokens: { total: 2 },
					})
				)
				expect(
					yield* ModelHealthService.use(health =>
						health.run(MODEL, generate)
					).pipe(Effect.flip)
				).toMatchObject({ _tag: 'TokenBudgetError', spent: 5 })
				expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(0)
			}).pipe(
				Effect.provide(
					healthLayer(() => Effect.succeed([FINISH]), { tokensPerRun: 5 })
				)
			)
	)

	test.effect(
		'exact token limit refuses the next call and preserves the shared ledger',
		() =>
			Effect.gen(function* () {
				const health = yield* ModelHealthService
				const ledger = yield* TokenLedger
				yield* health.run(MODEL, generate)
				const snapshot = yield* ledger.snapshot
				expect(snapshot).toMatchObject({
					'model-a': { calls: 1, totalTokens: 5 },
				})
				expect(
					yield* health.run(MODEL, generate).pipe(Effect.flip)
				).toMatchObject({ _tag: 'TokenBudgetError', spent: 5, limit: 5 })
				expect(yield* ledger.snapshot).toEqual(snapshot)
				expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(1)
			}).pipe(
				Effect.provide(
					healthLayer(() => Effect.succeed([FINISH]), { tokensPerRun: 5 })
				)
			)
	)
	for (const [status, detail] of [
		[400, 'model model-a not found'],
		[422, 'model model-a does not exist'],
		[422, 'model model-a not supported'],
		[400, 'model model-a unavailable'],
	] as const)
		test.effect(`drops unknown-model response ${status}: ${detail}`, () =>
			Effect.gen(function* () {
				const health = yield* ModelHealthService
				expect(
					getDropReason(
						new LlmError({
							model: MODEL.model,
							status,
							reason: 'InvalidRequestError',
							detail,
							retryable: false,
						})
					)
				).toBe(`unknown model (${status})`)
				expect(
					yield* health.run(MODEL, generate).pipe(Effect.flip)
				).toMatchObject({ _tag: 'ModelDroppedError', model: MODEL.model })
				expect(yield* health.isAvailable(MODEL.model)).toBe(false)
				expect(
					yield* health.run(MODEL, generate).pipe(Effect.flip)
				).toMatchObject({ _tag: 'ModelDroppedError' })
				expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(1)
				expect(yield* health.dropped).toEqual([
					{ model: MODEL.model, reason: `unknown model (${status})` },
				])
			}).pipe(
				Effect.provide(
					healthLayer(() => Effect.fail(providerError(status, detail)))
				)
			)
		)
})

for (const [status, detail] of [
	[400, 'Unknown MODEL model-a'],
	[400, 'no such model model-a'],
	[422, 'invalid model model-a'],
] as const)
	test(`classifies ${status}: ${detail} as an unknown model`, () => {
		expect(
			getDropReason(
				new LlmError({
					model: MODEL.model,
					status,
					reason: 'InvalidRequestError',
					detail,
					retryable: false,
				})
			)
		).toBe(`unknown model (${status})`)
	})
