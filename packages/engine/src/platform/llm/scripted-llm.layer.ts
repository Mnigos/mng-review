import type { ModelSetting } from '@mng-review/domain'
import { Context, Effect, Layer, Ref, Stream } from 'effect'
import { type AiError, LanguageModel, type Response } from 'effect/ai'
import { LlmError } from './llm.errors'
import { LlmService, type MeteredResponse, type ModelCall } from './llm.service'
import { TokenLedger } from './token-ledger.service'

/** One request the scripted model received, as `effect/ai` hands it to a provider. */
export interface ScriptedLlmCall {
	readonly model: ModelSetting
	readonly options: LanguageModel.ProviderOptions
}

/** The parts a scripted model answers with (text, tool calls, a `finish` part with usage), or its failure. */
export type ScriptedLlmAnswer = (
	call: ScriptedLlmCall,
	index: number
) => Effect.Effect<readonly Response.PartEncoded[], AiError.AiError>

/** What the scripted model was asked, in order. */
export class ScriptedLlm extends Context.Service<
	ScriptedLlm,
	{ readonly calls: Effect.Effect<readonly ScriptedLlmCall[]> }
>()('mng-review/ScriptedLlm') {}

/**
 * An `LlmService` whose model answers from a script instead of an endpoint, for specs and offline
 * runs. Requests go through `effect/ai` as with the real provider, so prompts, tools and answer
 * decoding are exercised; failures become `LlmError`s and usage reaches the token ledger.
 */
export function makeScriptedLlmLayer(
	answer: ScriptedLlmAnswer
): Layer.Layer<LlmService | ScriptedLlm, never, TokenLedger> {
	return Layer.effectContext(
		Effect.gen(function* () {
			const ledger = yield* TokenLedger
			const calls = yield* Ref.make<readonly ScriptedLlmCall[]>([])

			const makeModel = (model: ModelSetting) =>
				LanguageModel.make({
					generateText: options =>
						Ref.getAndUpdate(calls, current => [
							...current,
							{ model, options },
						]).pipe(
							Effect.flatMap(previous =>
								answer({ model, options }, previous.length)
							),
							Effect.map(parts => [...parts])
						),
					streamText: () => Stream.die('the scripted model does not stream'),
				})

			const run = Effect.fn('LlmService.run')(function* <
				TResponse extends MeteredResponse,
			>(model: ModelSetting, call: ModelCall<TResponse>) {
				const languageModel = yield* makeModel(model)
				const response = yield* call.pipe(
					Effect.provideService(LanguageModel.LanguageModel, languageModel),
					Effect.mapError(failure =>
						LlmError.fromFailure(failure, {
							model: model.model,
							secrets: [],
							timeout: 0,
						})
					)
				)
				yield* ledger.record(model.model, response.usage)
				return response
			})

			return Context.make(LlmService, { run }).pipe(
				Context.add(ScriptedLlm, { calls: Ref.get(calls) })
			)
		})
	)
}
