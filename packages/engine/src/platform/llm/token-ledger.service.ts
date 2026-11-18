import { Context, Effect, Layer, Ref } from 'effect'
import type { Response } from 'effect/ai'

/** Tokens one model spent in a run. */
export interface ModelTokens {
	readonly calls: number
	readonly inputTokens: number
	readonly outputTokens: number
	readonly reasoningTokens: number
	readonly totalTokens: number
}

/** Tokens per model name, as the run configured it. */
export type TokensByModel = Readonly<Record<string, ModelTokens>>

const EMPTY_TOKENS = {
	calls: 0,
	inputTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0,
	totalTokens: 0,
} as const satisfies ModelTokens

/**
 * Tokens spent per model in one run, from each response's `usage`. Budgets read `snapshot`
 * before a call; a missing count adds zero.
 */
export class TokenLedger extends Context.Service<
	TokenLedger,
	{
		readonly record: (
			model: string,
			usage: Response.Usage
		) => Effect.Effect<void>
		readonly snapshot: Effect.Effect<TokensByModel>
	}
>()('mng-review/TokenLedger') {}

/** Adds one call's usage to a model's running totals. */
function addUsage(tokens: ModelTokens, usage: Response.Usage): ModelTokens {
	const input = usage.inputTokens.total ?? 0
	const output = usage.outputTokens.total ?? 0
	return {
		calls: tokens.calls + 1,
		inputTokens: tokens.inputTokens + input,
		outputTokens: tokens.outputTokens + output,
		reasoningTokens:
			tokens.reasoningTokens + (usage.outputTokens.reasoning ?? 0),
		totalTokens: tokens.totalTokens + input + output,
	}
}

export const TokenLedgerLive = Layer.effect(
	TokenLedger,
	Effect.gen(function* () {
		const tokens = yield* Ref.make<TokensByModel>({})

		const record = Effect.fn('TokenLedger.record')(function* (
			model: string,
			usage: Response.Usage
		) {
			yield* Ref.update(tokens, current => ({
				...current,
				[model]: addUsage(current[model] ?? EMPTY_TOKENS, usage),
			}))
		})

		return { record, snapshot: Ref.get(tokens) }
	})
)
