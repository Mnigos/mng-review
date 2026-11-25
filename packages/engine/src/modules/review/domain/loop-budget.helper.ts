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

/**
 * Finder tokens under the run's cap that the plan left free: `FINDER_TOKEN_SHARE` of
 * `limits.tokens_per_run` minus the finders' planned tokens and the sizing grants. A main reviewer
 * conversation whose first call costs more tokens than its estimate takes the difference its grant
 * lacks from here (`ConversationBudget.applyRate`); what the room gives raises every finder's
 * run stop, and what it could not give is how far reading past the cap would go.
 */
export interface TokenRoom {
	/** Takes up to `tokens`; gives what is left when that is less, and returns what it gave. */
	readonly take: (tokens: number) => Effect.Effect<number>
	/** Tokens given so far. */
	readonly taken: Effect.Effect<number>
	/** Tokens asked for and not given. */
	readonly short: Effect.Effect<number>
}

/** A room of `tokens` for one run's finders; zero or less holds nothing. */
export function makeTokenRoom(tokens: number): Effect.Effect<TokenRoom> {
	return Effect.map(
		Ref.make({ left: Math.max(0, Math.floor(tokens)), taken: 0, short: 0 }),
		totals => ({
			take: asked =>
				Ref.modify(totals, entry => {
					const given = Math.min(Math.max(0, asked), entry.left)
					return [
						given,
						{
							left: entry.left - given,
							taken: entry.taken + given,
							short: entry.short + Math.max(0, asked) - given,
						},
					]
				}),
			taken: Effect.map(Ref.get(totals), entry => entry.taken),
			short: Effect.map(Ref.get(totals), entry => entry.short),
		})
	)
}

/**
 * Real input tokens per estimated token of a conversation's first message (`toEstimatedTokens`);
 * 1 without an estimate. The first call's input also carries the tool definitions.
 */
export function getTokenRate(
	realTokens: number,
	estimatedTokens: number
): number {
	return estimatedTokens > 0 ? realTokens / estimatedTokens : 1
}

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
	/** The run's free finder tokens; what any conversation takes from it raises `runTokens`. */
	readonly room?: TokenRoom
	/**
	 * Tokens the sizing added to this conversation's share for reading its cut files
	 * (`toSizedJobs`), at the estimated rate; `applyRate` scales them to the real one.
	 */
	readonly grant?: number
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
	/** Its first call's token rate (`getTokenRate`); unset when no call answered. */
	readonly tokenRate?: number
}

/** One conversation's token bounds as the loop checks them, its pool claims included. */
export interface ConversationBudget {
	/** The budget with what the conversation claimed from the pool added to its share. */
	readonly current: Effect.Effect<LoopBudget | undefined>
	/** Adds one call's input and output tokens to what the conversation spent. */
	readonly record: (tokens: number) => Effect.Effect<void>
	/**
	 * The result with what the whole conversation spent, what it left of its share and claims, and
	 * its token rate, read when it ends, so an answer kept from before a failed turn reports every call.
	 */
	readonly settle: <TResult extends SpentTokens>(
		result: TResult
	) => Effect.Effect<TResult>
	/**
	 * Claims from the pool what the conversation lacks to send `tokens` more with its next call,
	 * so tool outputs the pool can pay for are not refused; without a pool it claims nothing.
	 */
	readonly claimFor: (
		state: ConversationTokens,
		tokens: number
	) => Effect.Effect<void>
	/**
	 * True once the conversation cannot afford a call after the next one and the pool cannot cover
	 * the difference, or the whole run has spent its finder tokens (`spent`).
	 */
	readonly isSpent: (state: ConversationTokens) => Effect.Effect<boolean>
	/**
	 * After the first call: its token rate (`getTokenRate`), with what `grant` lacks at that rate,
	 * `grant` times the rate less 1, taken from `room` into the share. A rate under 1 takes nothing,
	 * so a conversation never gets less than the sizing granted. Only the first call counts; a later
	 * one returns the rate already measured.
	 */
	readonly applyRate: (
		realTokens: number,
		estimatedTokens: number
	) => Effect.Effect<number>
}

/** What a conversation took beyond its share, what it spent, and its first call's token rate. */
interface ConversationTotals {
	readonly granted: number
	readonly spent: number
	readonly rate?: number
}

/** A conversation's totals before its first call. */
const NO_TOTALS = { granted: 0, spent: 0 } as const satisfies ConversationTotals

/** The token bounds of one conversation: `budget`, plus what it claims from the budget's pool. */
export function makeConversationBudget(
	budget: LoopBudget | undefined,
	spent: Effect.Effect<number>
): Effect.Effect<ConversationBudget> {
	return Effect.map(Ref.make<ConversationTotals>(NO_TOTALS), totals => {
		const roomTaken = budget?.room ? budget.room.taken : Effect.succeed(0)
		const current = Effect.gen(function* () {
			if (budget === undefined) return undefined
			const entry = yield* Ref.get(totals)
			return {
				...budget,
				runTokens: budget.runTokens + (yield* roomTaken),
				conversationTokens: budget.conversationTokens + entry.granted,
			}
		})
		/** Moves `missing` tokens from the pool into the share; false when the pool cannot pay. */
		const claim = (missing: number) =>
			Effect.gen(function* () {
				if (!(budget?.pool && (yield* budget.pool.claim(missing)))) return false
				yield* Ref.update(totals, entry => ({
					...entry,
					granted: entry.granted + missing,
				}))
				return true
			})
		const isSpent = (state: ConversationTokens) =>
			Effect.gen(function* () {
				const now = yield* current
				if (now === undefined) return false
				if ((yield* spent) >= now.runTokens) return true
				const missing = getMissingTokens(now, state)
				return missing > 0 && !(yield* claim(missing))
			})
		const claimFor = (state: ConversationTokens, tokens: number) =>
			Effect.gen(function* () {
				const now = yield* current
				if (now === undefined) return
				const missing =
					state.spentTokens +
					state.nextInputTokens +
					tokens -
					now.conversationTokens
				if (missing > 0) yield* claim(missing)
			})
		const record = (tokens: number) =>
			Ref.update(totals, entry => ({ ...entry, spent: entry.spent + tokens }))
		const settle = <TResult extends SpentTokens>(result: TResult) =>
			Ref.get(totals).pipe(
				Effect.map(entry => ({
					...result,
					...(entry.rate === undefined ? {} : { tokenRate: entry.rate }),
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
		const applyRate = (realTokens: number, estimatedTokens: number) =>
			Effect.gen(function* () {
				const measured = (yield* Ref.get(totals)).rate
				if (measured !== undefined) return measured
				const rate = getTokenRate(realTokens, estimatedTokens)
				const given =
					budget?.room && budget.grant
						? yield* budget.room.take(
								Math.ceil(budget.grant * (Math.max(1, rate) - 1))
							)
						: 0
				yield* Ref.update(totals, entry => ({
					...entry,
					rate,
					granted: entry.granted + given,
				}))
				return rate
			})
		return { current, isSpent, record, settle, claimFor, applyRate }
	})
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

/** Whether a turn was forced by the token budget; once set it stays, so a corrected answer keeps it. */
interface BudgetMark {
	readonly budgetForced?: true
}

/** The budget mark a turn carries: set when this turn or an earlier one was forced by the budget. */
export function toBudgetMark(
	earlier: BudgetMark['budgetForced'],
	spent: boolean
): BudgetMark {
	return earlier || spent ? { budgetForced: true } : {}
}
