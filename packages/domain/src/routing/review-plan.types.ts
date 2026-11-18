import type { AgentInput, AgentKind } from '../agents/agent-front-matter.schema'
import type { DeclaredAgent } from '../agents/agent.types'
import type { ChangedFile } from '../change/change.types'
import type { Effort, ReviewConfig } from '../config/review-config.schema'
import type {
	ChangeShape,
	Depth,
	PullRequestInfo,
	Risk,
	RouterReport,
} from './routing.types'

/** What a plan is built from. */
export interface PlanInput {
	readonly config: ReviewConfig
	readonly agents: readonly DeclaredAgent[]
	/** Changed files with skips already applied. */
	readonly files: readonly ChangedFile[]
	readonly pr: PullRequestInfo
}

/** The engine does not ask the router; the plan uses this report. */
export interface RouterSkipped {
	readonly status: 'skip'
	readonly router: RouterReport
}

/** The engine asks the router about these candidates and files. */
export interface RouterWanted {
	readonly status: 'route'
	readonly candidates: readonly DeclaredAgent[]
	readonly files: readonly ChangedFile[]
}

export type PlanRouting = RouterSkipped | RouterWanted

/** One planned run of the main reviewer or of a declared agent. */
export interface PlannedRun {
	/** `reviewer` for the main reviewer, otherwise the agent's file name. */
	readonly name: string
	readonly title: string
	readonly role: 'reviewer' | 'agent'
	readonly kind: AgentKind
	readonly input: AgentInput
	readonly model: string
	readonly effort: Effort
	readonly files: readonly string[]
	/** `default`: the main reviewer or an agent without `when.paths`. */
	readonly selectedBy: 'default' | 'paths' | 'router'
	/** The router's reason when it added the agent. */
	readonly reason?: string
}

/** A role or agent that does not run, and why. */
export interface PlannedSkip {
	readonly name: string
	readonly title: string
	readonly reason: string
}

/** Which agents run, which are skipped and why, the risk and the depth. */
export interface Plan {
	/** Set when the whole run is skipped. */
	readonly skippedRun: string | undefined
	readonly files: readonly ChangedFile[]
	readonly risk: Risk
	/** `mechanical`: a repo-wide mechanical change, kept at `normal` or below. */
	readonly riskSource: 'risk_paths' | 'mechanical' | 'router' | 'default'
	readonly riskPathHits: readonly string[]
	/** The change against the mechanical conditions; unset when the run is skipped. */
	readonly shape?: ChangeShape
	readonly depth: Depth
	readonly depthSource: string
	readonly router: RouterReport
	readonly runs: readonly PlannedRun[]
	readonly skips: readonly PlannedSkip[]
}
