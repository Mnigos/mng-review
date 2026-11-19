import { Effect, Ref } from 'effect'
import { CHARS_PER_TOKEN } from './review.constants'

/**
 * Finder tokens a run planned but a finder left unspent: a finder that answers under its share
 * gives the rest back, and the main reviewer conversations may claim it. Claims never exceed what
 * was given back, so the finders together still spend about what the run planned.
 */
export interface TokenPool {
	/** Gives back tokens a finder did not spend; zero or less gives nothing. */
	readonly release: (tokens: number) => Effect.Effect<void>
	/** Takes `tokens` from the pool when it holds that many; false leaves the pool as it was. */
	readonly claim: (tokens: number) => Effect.Effect<boolean>
	/** Tokens given back and not yet claimed. */
	readonly available: Effect.Effect<number>
}

/** An empty pool for one run's finders. */
export const makeTokenPool: Effect.Effect<TokenPool> = Effect.map(
	Ref.make(0),
	left => ({
		release: tokens =>
			Ref.update(left, current => current + Math.max(0, Math.floor(tokens))),
		claim: tokens =>
			Ref.modify(left, current =>
				tokens <= current ? [true, current - tokens] : [false, current]
			),
		available: Ref.get(left),
	})
)

/** Token bounds of one agent conversation. */
export interface LoopBudget {
	/** The agent answers once the whole run has spent this many tokens. */
	readonly runTokens: number
	/**
	 * The agent answers before its own conversation passes this many tokens: a call costs at least
	 * the input of the call before it, so it wraps up once that would no longer fit.
	 */
	readonly conversationTokens: number
	/**
	 * Where the conversation may claim more once its own share would stop it; only the main
	 * reviewer's conversations get one.
	 */
	readonly pool?: TokenPool
	/**
	 * Tokens of `conversationTokens` held back until the conversation gets its continuation turn,
	 * so a finder that answers with changed files unread can still read them.
	 */
	readonly reserve?: number
}

/** What a conversation has spent so far. */
export interface ConversationTokens {
	/** Tokens this conversation has spent. */
	readonly spentTokens: number
	/**
	 * Estimated input of the conversation's next call: the last call's input and output plus the
	 * tool results it will send, or the first message's estimate before the first call.
	 */
	readonly nextInputTokens: number
}

/** Why a turn's repository calls do not run: the agent must answer, or its tokens ran out. */
export interface CallStop {
	readonly wrapUp: boolean
	readonly outOfTokens: boolean
}

/**
 * True when the conversation cannot afford a call after the next one: a call costs at least the
 * next call's estimated input, and the one after it more, so once two would pass its share, the
 * next call must be the answer.
 */
export function isOutOfTokens(
	budget: LoopBudget | undefined,
	state: ConversationTokens
): boolean {
	return (
		budget !== undefined &&
		state.spentTokens + 2 * state.nextInputTokens >= budget.conversationTokens
	)
}

/**
 * Tokens the conversation lacks to afford a call after the next one; 0 when it can. A conversation
 * with a pool claims this much before it wraps up.
 */
export function getMissingTokens(
	budget: LoopBudget,
	state: ConversationTokens
): number {
	const needed = state.spentTokens + 2 * state.nextInputTokens
	return needed < budget.conversationTokens
		? 0
		: needed - budget.conversationTokens + 1
}

/** What a finished conversation spent and left unspent. */
export interface SpentTokens {
	readonly spentTokens: number
	/** Tokens of its share and pool claims it left unspent; what its finder gives back to the pool. */
	readonly unspentTokens: number
}

/** One conversation's token bounds as the loop checks them, its pool claims included. */
export interface ConversationBudget {
	/**
	 * The budget with what the conversation claimed from the pool added to its share, and its
	 * reserve held back until `openReserve`.
	 */
	readonly current: Effect.Effect<LoopBudget | undefined>
	/** Adds one call's input and output tokens to what the conversation spent. */
	readonly record: (tokens: number) => Effect.Effect<void>
	/**
	 * The result with what the whole conversation spent and what it left of its share and pool
	 * claims, read when it ends, so an answer kept from before a failed turn reports every call.
	 */
	readonly settle: <TResult extends SpentTokens>(
		result: TResult
	) => Effect.Effect<TResult>
	/** Makes the reserve part of the share, for the continuation turn. */
	readonly openReserve: Effect.Effect<void>
	/**
	 * True once the conversation cannot afford a call after the next one and the pool cannot cover
	 * the difference, or the whole run has spent its finder tokens (`spent`).
	 */
	readonly isSpent: (state: ConversationTokens) => Effect.Effect<boolean>
}

/** The token bounds of one conversation: `budget`, plus what it claims from the budget's pool. */
export function makeConversationBudget(
	budget: LoopBudget | undefined,
	spent: Effect.Effect<number>
): Effect.Effect<ConversationBudget> {
	return Effect.map(
		Ref.make({ granted: 0, spent: 0, opened: false }),
		totals => {
			const current = Ref.get(totals).pipe(
				Effect.map(entry => {
					if (budget === undefined) return undefined
					const held = entry.opened ? 0 : (budget.reserve ?? 0)
					return {
						...budget,
						conversationTokens:
							budget.conversationTokens + entry.granted - held,
					}
				})
			)
			const isSpent = (state: ConversationTokens) =>
				Effect.gen(function* () {
					const now = yield* current
					if (now === undefined) return false
					if ((yield* spent) >= now.runTokens) return true
					const missing = getMissingTokens(now, state)
					if (missing === 0) return false
					if (!(now.pool && (yield* now.pool.claim(missing)))) return true
					yield* Ref.update(totals, entry => ({
						...entry,
						granted: entry.granted + missing,
					}))
					return false
				})
			const record = (tokens: number) =>
				Ref.update(totals, entry => ({ ...entry, spent: entry.spent + tokens }))
			const settle = <TResult extends SpentTokens>(result: TResult) =>
				Ref.get(totals).pipe(
					Effect.map(entry => ({
						...result,
						spentTokens: entry.spent,
						unspentTokens:
							budget === undefined
								? 0
								: Math.max(
										0,
										budget.conversationTokens + entry.granted - entry.spent
									),
					}))
				)
			const openReserve = Ref.update(totals, entry => ({
				...entry,
				opened: true,
			}))
			return { current, isSpent, record, settle, openReserve }
		}
	)
}

/** Tokens a text is assumed to take, at `CHARS_PER_TOKEN`. */
export function toEstimatedTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Tool outputs cut to what the conversation can still send: once their estimated tokens would leave
 * no room for the next call within the share, the rest are replaced by `refusal`. Without a budget
 * every output stays.
 */
export function toAffordableOutputs(
	outputs: readonly string[],
	budget: LoopBudget | undefined,
	state: ConversationTokens,
	refusal: string
): string[] {
	if (budget === undefined) return [...outputs]
	const room =
		budget.conversationTokens - state.spentTokens - state.nextInputTokens
	return outputs.reduce<{ kept: string[]; used: number }>(
		(acc, output) => {
			const used = acc.used + toEstimatedTokens(output)
			return used > room
				? { kept: [...acc.kept, refusal], used: acc.used }
				: { kept: [...acc.kept, output], used }
		},
		{ kept: [], used: 0 }
	).kept
}
