import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai-compat'
import type { ModelSetting } from '@mng-review/domain'
import {
	Clock,
	Context,
	Effect,
	Layer,
	Redacted,
	Schedule,
	Semaphore,
} from 'effect'
import type { AiError, LanguageModel, Response } from 'effect/ai'
import { EndpointConfig } from '../config/endpoint.config'
import {
	LLM_CALL_TIMEOUT,
	LLM_MAX_RETRIES,
	LLM_MAX_RETRY_AFTER_MILLIS,
	LLM_RETRY_DELAY_MILLIS,
} from './llm.constants'
import { LlmError } from './llm.errors'
import { TokenLedger } from './token-ledger.service'

/** A model answer the token ledger can count. */
export interface MeteredResponse {
	readonly usage: Response.Usage
}

/**
 * One request to a model: it needs only the `LanguageModel`; the caller provides anything else
 * (tool handlers, its own services) before handing it over.
 */
export type ModelCall<TResponse> = Effect.Effect<
	TResponse,
	AiError.AiError,
	LanguageModel.LanguageModel
>

/** How many model calls run at once: `limits.concurrency` from `review.yml`. */
export class LlmSettings extends Context.Service<
	LlmSettings,
	{ readonly concurrency: number }
>()('mng-review/LlmSettings') {}

/**
 * Runs one model call against the endpoint. `call` is any `effect/ai` request that needs a
 * `LanguageModel` (`LanguageModel.generateText`, a `Chat` step); the service provides the model by
 * name, sets `reasoning_effort`, waits for a free slot, applies the timeout, retries once on 429 or
 * 5xx, counts the tokens and turns every failure into a redacted `LlmError`. Dropping models and
 * token budgets wrap this call.
 */
export class LlmService extends Context.Service<
	LlmService,
	{
		readonly run: <TResponse extends MeteredResponse>(
			model: ModelSetting,
			call: ModelCall<TResponse>
		) => Effect.Effect<TResponse, LlmError>
	}
>()('mng-review/LlmService') {}

/** Retries once, after the endpoint's `Retry-After` or the default delay. */
const RETRY_SCHEDULE = Schedule.recurs(LLM_MAX_RETRIES).pipe(
	Schedule.setInputType<LlmError>(),
	Schedule.modifyDelay(({ input }) =>
		Effect.succeed(input.retryAfterMillis ?? LLM_RETRY_DELAY_MILLIS)
	)
)

/** A 429 or 5xx whose `Retry-After`, if any, is short enough to wait for. */
function isRetryWorthy(error: LlmError): boolean {
	return (
		error.retryable &&
		(error.retryAfterMillis ?? 0) <= LLM_MAX_RETRY_AFTER_MILLIS
	)
}

/** Everything that names the endpoint: the key, the URL, its origin and its host. */
function toSecrets(url: string, key: string | undefined): string[] {
	const parsed = new URL(url)
	return [url, parsed.origin, parsed.host, ...(key ? [key] : [])]
}

export const LlmServiceLive = Layer.effect(
	LlmService,
	Effect.gen(function* () {
		const endpoint = yield* EndpointConfig
		const ledger = yield* TokenLedger
		const { concurrency } = yield* LlmSettings
		const key = endpoint.key ? Redacted.value(endpoint.key).trim() : ''
		const client = yield* OpenAiClient.make({
			apiUrl: endpoint.url,
			apiKey: key ? Redacted.make(key) : undefined,
		})
		const secrets = toSecrets(endpoint.url, key)
		const slots = yield* Semaphore.make(concurrency)

		const run = Effect.fn('LlmService.run')(function* <
			TResponse extends MeteredResponse,
		>(model: ModelSetting, call: ModelCall<TResponse>) {
			yield* Effect.annotateCurrentSpan({
				model: model.model,
				effort: model.effort,
			})
			const response = yield* call.pipe(
				OpenAiLanguageModel.withConfigOverride({
					reasoning_effort: model.effort,
				}),
				Effect.provide(OpenAiLanguageModel.model(model.model)),
				Effect.provideService(OpenAiClient.OpenAiClient, client),
				Effect.timeout(LLM_CALL_TIMEOUT),
				Effect.catch(error =>
					Clock.currentTimeMillis.pipe(
						Effect.flatMap(now =>
							Effect.fail(
								LlmError.fromFailure(error, {
									model: model.model,
									secrets,
									timeout: LLM_CALL_TIMEOUT,
									now,
								})
							)
						)
					)
				),
				slots.withPermits(1),
				Effect.retry({ while: isRetryWorthy, schedule: RETRY_SCHEDULE })
			)
			yield* ledger.record(model.model, response.usage)
			return response
		})

		return { run }
	})
)
