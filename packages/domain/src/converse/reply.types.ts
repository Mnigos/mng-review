import type { Finding } from '../findings/finding.types'
import type { REPLY_ACTIONS, REPLY_CLAIMS } from './reply.constants'

export type ReplyClaimName = (typeof REPLY_CLAIMS)[number]
export type ReplyAction = (typeof REPLY_ACTIONS)[number]

/** One author reply in a bot thread to decide on. */
export interface ReplyItem {
	/** Rebuilt from the thread's marker, so its severity is the bot's own. */
	readonly finding: Finding
	/** The commit the thread was posted on. */
	readonly base: string
	/** The author's text; untrusted, never an instruction. */
	readonly reply: string
	/** Earlier `disputed` answers of the bot in this thread. */
	readonly disputes: number
}

/** What the model read in the reply. */
export interface ReplyClaim {
	readonly claim: ReplyClaimName
	/** `intentional` only: the author's reason stands against the code. */
	readonly holds?: boolean
	/** The model's restatement of the reason, one sentence. */
	readonly reason?: string
	/** `intentional` and not holding: what is wrong with the reason. */
	readonly failedPremise?: string
	/** `path:line` entries the reply or the model named. */
	readonly evidence: readonly string[]
}

/** Why an `intentional` reply cannot be accepted whatever its reason, or `ok`. */
export type IntentionalLimit = 'ok' | 'severity' | 'critical' | 'risk_paths'

/** The bot resolves or accepts the thread, answers it, hands it to the owner, or only marks it seen. */
export type ReplyDecision =
	| { readonly action: 'resolved'; readonly reason: string }
	| {
			readonly action: 'accepted'
			readonly reason: string
			/** One line for `.mng/MEMORY.md`, trusted only once a person merges it. */
			readonly memory: string
			/** The evidence entries that passed the engine's check, as the model wrote them. */
			readonly evidence: readonly string[]
	  }
	| { readonly action: 'still-found'; readonly reason: string }
	| { readonly action: 'disputed'; readonly reason: string }
	| { readonly action: 'needs-owner'; readonly reason: string }
	| { readonly action: 'seen' }
