import { Context, Effect, Layer, Ref } from 'effect'
import type { Response } from 'effect/ai'

/** Tokens one model spent in a run. */
export interface ModelTokens {
	readonly calls: number
	readonly inputTokens: number
	/** Input tokens the endpoint read from its prompt cache; part of `inputTokens`. */
	readonly cachedInputTokens: number
	readonly outputTokens: number
	readonly reasoningTokens: number
	readonly totalTokens: number
}

/** Tokens per model name, as the run configured it. */
export type TokensByModel = Readonly<Record<string, ModelTokens>>

/**
 * Where one source's input tokens went: each conversation's first message (system prompt and the
 * change) re-sent on every call, and the history the conversation grew (tool output, the model's
 * own turns, corrections).
 */
export interface SourceTokens extends ModelTokens {
	/** Agent conversations: one per unit, finder or validated finding. */
	readonly conversations: number
	/** Input spent re-sending each conversation's first message, once per call. */
	readonly firstMessageTokens: number
	/** Input spent on the history: `inputTokens` minus `firstMessageTokens`. */
	readonly historyTokens: number
}

/** Tokens per source: a finder's name or `validator`. */
export type TokensBySource = Readonly<Record<string, SourceTokens>>

/** One agent turn's usage and what its conversation's first message cost. */
export interface TurnUsage {
	readonly usage: Response.Usage
	/** Input tokens of the conversation's first call. */
	readonly firstMessageTokens: number
	/** The conversation's first call. */
	readonly first: boolean
}

const EMPTY_TOKENS = {
	calls: 0,
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0,
	totalTokens: 0,
} as const satisfies ModelTokens
const EMPTY_SOURCE = {
	...EMPTY_TOKENS,
	conversations: 0,
	firstMessageTokens: 0,
	historyTokens: 0,
} as const satisfies SourceTokens

/**
 * Tokens spent per model in one run, from each response's `usage`, and per source from the agent
 * loops' turns. Budgets read `snapshot` before a call; a missing count adds zero.
 */
export class TokenLedger extends Context.Service<
	TokenLedger,
	{
		readonly record: (
			model: string,
			usage: Response.Usage
		) => Effect.Effect<void>
		readonly recordTurn: (
			source: string,
			turn: TurnUsage
		) => Effect.Effect<void>
		readonly snapshot: Effect.Effect<TokensByModel>
		readonly sources: Effect.Effect<TokensBySource>
	}
>()('mng-review/TokenLedger') {}

/** Adds one call's usage to a model's running totals. */
function addUsage<TTokens extends ModelTokens>(
	tokens: TTokens,
	usage: Response.Usage
): TTokens {
	const input = usage.inputTokens.total ?? 0
	const output = usage.outputTokens.total ?? 0
	return {
		...tokens,
		calls: tokens.calls + 1,
		inputTokens: tokens.inputTokens + input,
		cachedInputTokens:
			tokens.cachedInputTokens + (usage.inputTokens.cacheRead ?? 0),
		outputTokens: tokens.outputTokens + output,
		reasoningTokens:
			tokens.reasoningTokens + (usage.outputTokens.reasoning ?? 0),
		totalTokens: tokens.totalTokens + input + output,
	}
}

/** Adds one agent turn to a source's totals. */
function addTurn(tokens: SourceTokens, turn: TurnUsage): SourceTokens {
	const added = addUsage(tokens, turn.usage)
	const firstMessageTokens = tokens.firstMessageTokens + turn.firstMessageTokens
	return {
		...added,
		conversations: tokens.conversations + (turn.first ? 1 : 0),
		firstMessageTokens,
		historyTokens: added.inputTokens - firstMessageTokens,
	}
}

export const TokenLedgerLive = Layer.effect(
	TokenLedger,
	Effect.gen(function* () {
		const tokens = yield* Ref.make<TokensByModel>({})
		const bySource = yield* Ref.make<TokensBySource>({})

		const record = Effect.fn('TokenLedger.record')(function* (
			model: string,
			usage: Response.Usage
		) {
			yield* Ref.update(tokens, current => ({
				...current,
				[model]: addUsage(current[model] ?? EMPTY_TOKENS, usage),
			}))
		})

		const recordTurn = Effect.fn('TokenLedger.recordTurn')(function* (
			source: string,
			turn: TurnUsage
		) {
			yield* Ref.update(bySource, current => ({
				...current,
				[source]: addTurn(current[source] ?? EMPTY_SOURCE, turn),
			}))
		})

		return {
			record,
			recordTurn,
			snapshot: Ref.get(tokens),
			sources: Ref.get(bySource),
		}
	})
)
