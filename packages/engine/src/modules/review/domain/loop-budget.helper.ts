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
	/** Input tokens of the conversation's last call, or the first message's estimate before it. */
	readonly lastInputTokens: number
}

/** Why a turn's repository calls do not run: the agent must answer, or its tokens ran out. */
export interface CallStop {
	readonly wrapUp: boolean
	readonly outOfTokens: boolean
}

/**
 * True when the conversation cannot afford a call after the next one: each call costs at least
 * the input of the call before it, so once two more would pass its share, the next call must be the
 * answer. Before the first call, `lastInputTokens` is the first message's estimated size.
 */
export function isOutOfTokens(
	budget: LoopBudget | undefined,
	state: ConversationTokens
): boolean {
	return (
		budget !== undefined &&
		state.spentTokens + 2 * state.lastInputTokens >= budget.conversationTokens
	)
}

/** Tokens a text is assumed to take, at `CHARS_PER_TOKEN`. */
export function toEstimatedTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}
