import type { ModelSetting } from '@mng-review/domain'
import { Context, Effect, Layer, Ref, Semaphore } from 'effect'
import type { LlmError } from '../../../../platform/llm/llm.errors'
import {
	LlmService,
	type MeteredResponse,
	type ModelCall,
} from '../../../../platform/llm/llm.service'
import { TokenLedger } from '../../../../platform/llm/token-ledger.service'
import type { DroppedModel } from '../../domain/review-report.types'
import { ModelDroppedError, TokenBudgetError } from '../../domain/review.errors'
import { ReviewLimits } from '../review-limits.context'

/** Why a model call failed in a way the run can go on from. */
export type ModelCallError = LlmError | ModelDroppedError | TokenBudgetError

/**
 * An unknown-model answer: the provider's code or a message that says the model does not exist.
 * "model parameter" names a request setting, not the model, so it never counts.
 */
const UNKNOWN_MODEL =
	/model_not_found|(?:unknown|no such|invalid)\s+model\b(?![\s_-]*param)|model\b(?![\s_-]*param).*\b(?:not found|unknown|does not exist|not supported|no such|unavailable)/iu

/** Why an error drops its model for the rest of the run, or `undefined` to keep the model. */
export function getDropReason(error: LlmError): string | undefined {
	if (error.status === 429) return 'rate limited (429)'
	if (error.status === 503) return 'unavailable (503)'
	const unknown =
		error.status === 404 ||
		(error.reason === 'InvalidRequestError' && UNKNOWN_MODEL.test(error.detail))
	return unknown ? `unknown model (${error.status ?? error.reason})` : undefined
}

/**
 * Model calls of one review run. A call waits for one of `limits.concurrency` slots; once it has
 * one, it fails at once when its model was dropped or the run spent `limits.tokens_per_run`. A model
 * that answers 429, 503 or "unknown model" (after the model service's one retry) is dropped for the
 * rest of the run.
 */
export class ModelHealthService extends Context.Service<
	ModelHealthService,
	{
		readonly run: <TResponse extends MeteredResponse>(
			model: ModelSetting,
			call: ModelCall<TResponse>
		) => Effect.Effect<TResponse, ModelCallError>
		readonly isAvailable: (model: string) => Effect.Effect<boolean>
		readonly dropped: Effect.Effect<readonly DroppedModel[]>
	}
>()('mng-review/ModelHealthService') {}

export const ModelHealthServiceLive = Layer.effect(
	ModelHealthService,
	Effect.gen(function* () {
		const llm = yield* LlmService
		const ledger = yield* TokenLedger
		const limits = yield* ReviewLimits
		const slots = yield* Semaphore.make(limits.concurrency)
		const dropped = yield* Ref.make<ReadonlyMap<string, string>>(new Map())

		const checkCall = Effect.fn('ModelHealthService.checkCall')(function* (
			model: string
		) {
			const reason = (yield* Ref.get(dropped)).get(model)
			if (reason !== undefined)
				return yield* new ModelDroppedError({ model, reason })
			const tokens = Object.values(yield* ledger.snapshot)
			const spent = tokens.reduce((sum, entry) => sum + entry.totalTokens, 0)
			if (spent >= limits.tokensPerRun)
				return yield* new TokenBudgetError({
					spent,
					limit: limits.tokensPerRun,
				})
			return spent
		})

		const drop = (
			model: string,
			error: LlmError
		): Effect.Effect<never, LlmError | ModelDroppedError> => {
			const reason = getDropReason(error)
			if (reason === undefined) return Effect.fail(error)
			return Ref.update(dropped, current =>
				current.has(model) ? current : new Map([...current, [model, reason]])
			).pipe(
				Effect.andThen(
					Effect.fail(
						new ModelDroppedError({
							model,
							reason: `${reason}: ${error.detail}`,
						})
					)
				)
			)
		}

		const run = Effect.fn('ModelHealthService.run')(function* <
			TResponse extends MeteredResponse,
		>(
			model: ModelSetting,
			call: ModelCall<TResponse>
		): Effect.fn.Return<TResponse, ModelCallError> {
			return yield* checkCall(model.model).pipe(
				Effect.andThen(llm.run(model, call)),
				slots.withPermits(1),
				Effect.catchTag('LlmError', error => drop(model.model, error))
			)
		})

		const isAvailable = (model: string) =>
			Ref.get(dropped).pipe(Effect.map(current => !current.has(model)))

		const droppedModels = Ref.get(dropped).pipe(
			Effect.map(current =>
				[...current].map(([model, reason]) => ({ model, reason }))
			)
		)

		return { run, isAvailable, dropped: droppedModels }
	})
)
