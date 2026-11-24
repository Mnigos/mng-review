import type { AgentKind, Effort, ReviewOutcome } from '@mng-review/domain'
import type {
	TokensByModel,
	TokensBySource,
} from '../../../platform/llm/token-ledger.service'
import type { RiskRating } from '../../risk/domain/risk-rating.types'
import type { PlanReport } from '../../routing/domain/plan-report.types'
import type { UNREAD_REASONS } from './review.constants'

/** Why a changed file counts as unread (`UNREAD_REASONS`). */
export type UnreadReason = (typeof UNREAD_REASONS)[number]

/** A changed file a main reviewer conversation answered without receiving whole, and why. */
export interface UnreadFile {
	readonly path: string
	readonly reason: UnreadReason
}

/** A model the run stopped using, and why. */
export interface DroppedModel {
	readonly model: string
	readonly reason: string
}

/** How one planned run of the main reviewer or a declared agent went. */
export interface AgentRunReport {
	readonly name: string
	readonly title: string
	readonly kind: AgentKind
	/** The models that answered; the planned one unless it was dropped. */
	readonly model: string
	readonly effort: Effort
	/** `incomplete`: the token budget stopped a unit or the agent before it answered. */
	readonly status: 'ok' | 'incomplete' | 'failed'
	readonly error?: string
	/** The failure came from the model endpoint itself, not a dropped model or the token budget. */
	readonly endpointError?: boolean
	/** The planned model, when the run switched to another one because it was dropped. */
	readonly fellBackFrom?: string
	readonly toolCalls: number
	readonly findings: number
	/** Malformed findings the answer parser dropped. */
	readonly malformed: number
	/** Sub-agents of a deep review split into units. */
	readonly units?: number
	/** Conversations that got a continuation turn for changed files they had not read. */
	readonly continued?: number
	/**
	 * Changed files in the agent's scope that it answered without reading: neither shown whole in
	 * its first message nor read with a tool, after any continuation turn. Only the main reviewer
	 * is held to reading every file; unset when none.
	 */
	readonly unread?: number
	/** The files `unread` counts, each with its reason, in unit order; unset when none. */
	readonly unreadFiles?: readonly UnreadFile[]
	/** Units the token budget stopped before they answered; the agent's name when it is not split. */
	readonly unfinished?: readonly string[]
	readonly wallMillis: number
}

/** A run that reached `limits.tokens_per_run` before every agent and validator answered. */
export interface IncompleteRun {
	readonly reason: string
	/** Finders and units that gave no answer, and the validations that did not run. */
	readonly unfinished: readonly string[]
}

/**
 * A deep review whose main reviewer needs more tokens to read every changed file than the run may
 * plan: its finders together plan at most `cap`, `FINDER_TOKEN_SHARE` of `limits.tokens_per_run`.
 */
export interface CoverageCap {
	/** Finder tokens reading every changed file needs. */
	readonly needed: number
	readonly cap: number
}

/** What `mng-review --base` reports: the plan, the outcome and what the run took. */
export interface ReviewReport extends ReviewOutcome {
	readonly planReport: PlanReport
	readonly agents: readonly AgentRunReport[]
	readonly tokens: TokensByModel
	/** Finder and validator tokens by source; the router counts only by model. */
	readonly tokenSources: TokensBySource
	readonly droppedModels: readonly DroppedModel[]
	readonly wallMillis: number
	/** Set when a finder failed at the endpoint, or no reviewer model is left. */
	readonly endpointError?: string
	/** Set when the token budget stopped work; the findings that were produced are kept. */
	readonly incomplete?: IncompleteRun
	/** Set when reading every changed file needs more than the run may plan; the run read within it. */
	readonly capped?: CoverageCap
	/** A kept bug at or above its severity floor. */
	readonly blocking: boolean
	/** The risk rating, set only on a full run with `risk.enabled` (`isRatingRun`). */
	readonly rating?: RiskRating
}
