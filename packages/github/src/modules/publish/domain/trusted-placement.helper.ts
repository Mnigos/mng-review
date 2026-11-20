import {
	type AgentsByName,
	type DeclaredAgent,
	getSeverityFloor,
	hasBlockingBug,
	isAtLeast,
	type KeptFinding,
	placeNits,
	type ReviewConfig,
} from '@mng-review/domain'
import type { ReviewReport } from '@mng-review/engine'

/** The rules placement follows: the configuration and the declared agents at the base commit. */
export interface PlacementRules {
	readonly config: ReviewConfig
	readonly agents: readonly DeclaredAgent[]
}

/**
 * The report with every finding placed again from the given rules, as the engine places them: a
 * bug inline when it is not unverified and at or above its severity floor, nits inline up to the
 * run's and each agent's `max_nits`. Publishing never takes placement from the file it read.
 */
export function toTrustedPlacement(
	report: ReviewReport,
	rules: PlacementRules
): ReviewReport {
	const agents: AgentsByName = new Map(
		rules.agents.map(agent => [agent.name, agent])
	)
	const bugs = report.bugs.map((bug): KeptFinding => ({
		...bug,
		placement:
			bug.validation?.status !== 'unverified' &&
			isAtLeast(bug.severity, getSeverityFloor(bug, rules.config, agents))
				? 'inline'
				: 'summary',
	}))
	// placeNits copies each nit whole and sets only its placement.
	const nits: readonly KeptFinding[] = placeNits(
		report.nits,
		rules.config,
		agents
	)
	return { ...report, bugs, nits, blocking: hasBlockingBug(bugs) }
}
