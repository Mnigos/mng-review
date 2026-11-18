import { CHARS_PER_TOKEN } from './review.constants'

/** Token bounds of one agent conversation. */
export interface LoopBudget {
	/** The agent answers once the whole run has spent this many tokens. */
	readonly runTokens: number
	/**
	 * The agent answers before its own conversation passes this many tokens: a call costs at least
	 * the input of the call before it, so it wraps up once that would no longer fit.
	 */
	readonly conversationTokens: number
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
