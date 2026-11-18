import type { AgentKind } from '../agents/agent-front-matter.schema'
import type { Severity } from '../config/review-config.schema'

/** One reported problem, attributed to the agents and models that reported it. */
export interface Finding {
	readonly path: string
	readonly line: number
	readonly severity: Severity
	readonly title: string
	readonly trigger: string
	readonly impact: string
	readonly evidence: readonly string[]
	readonly suggestion?: string
	readonly kind: AgentKind
	/** Agents that reported it; more than one after a merge. */
	readonly agents: readonly string[]
	/** Models that reported it; more than one after a merge. */
	readonly models: readonly string[]
	readonly fingerprint: string
}

/** Who reported a finding. */
export interface FindingReporter {
	readonly agent: string
	readonly kind: AgentKind
	readonly model: string
}

/** `inline`: its own comment; `summary`: listed in the summary only. */
export type FindingPlacement = 'inline' | 'summary'

/** A finding with where it is published. */
export interface PlacedFinding extends Finding {
	readonly placement: FindingPlacement
}
