import type { AgentKind, Effort, ReviewOutcome } from '@mng-review/domain'
import type { TokensByModel } from '../../../platform/llm/token-ledger.service'
import type { PlanReport } from '../../routing/domain/plan-report.types'

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
	readonly status: 'ok' | 'failed'
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
	readonly wallMillis: number
}

/** What `mng-review --base` reports: the plan, the outcome and what the run took. */
export interface ReviewReport extends ReviewOutcome {
	readonly planReport: PlanReport
	readonly agents: readonly AgentRunReport[]
	readonly tokens: TokensByModel
	readonly droppedModels: readonly DroppedModel[]
	readonly wallMillis: number
	/** Set when a finder failed at the endpoint, or no reviewer model is left. */
	readonly endpointError?: string
	/** A kept bug at or above its severity floor. */
	readonly blocking: boolean
}
