import { getAgentSettings } from '../agents/agent.helper'
import type { DeclaredAgent } from '../agents/agent.types'
import type { ReviewConfig, Severity } from '../config/review-config.schema'
import { getSeverityRank, sortFindings } from './finding.helper'
import type { Finding, PlacedFinding } from './finding.types'

/** Declared agents by name. */
export type AgentsByName = ReadonlyMap<string, DeclaredAgent>

/**
 * The severity floor of a finding: the lowest `comments.min_severity` among the agents that
 * reported it. The main reviewer and unknown agents use `review.yml`.
 */
export function getSeverityFloor(
	finding: Pick<Finding, 'agents'>,
	config: ReviewConfig,
	agents: AgentsByName
): Severity {
	const [first = config.comments.min_severity, ...rest] = finding.agents.map(
		name => {
			const agent = agents.get(name)
			return agent
				? getAgentSettings(agent, config).comments.min_severity
				: config.comments.min_severity
		}
	)
	return rest.reduce(
		(lowest, floor) =>
			getSeverityRank(floor) < getSeverityRank(lowest) ? floor : lowest,
		first
	)
}

/**
 * Places nits, most severe first: inline while the run stays under `comments.max_nits` and the
 * first reporting agent under its own `max_nits`; the rest go to the summary.
 */
export function placeNits(
	nits: readonly Finding[],
	config: ReviewConfig,
	agents: AgentsByName
): PlacedFinding[] {
	const inlineByAgent = new Map<string, number>()
	return sortFindings(nits).map(nit => {
		const name = nit.agents[0] ?? ''
		const agent = agents.get(name)
		const agentCap = agent
			? getAgentSettings(agent, config).comments.max_nits
			: Number.POSITIVE_INFINITY
		const used = inlineByAgent.get(name) ?? 0
		const total = [...inlineByAgent.values()].reduce((sum, n) => sum + n, 0)
		if (total >= config.comments.max_nits || used >= agentCap)
			return { ...nit, placement: 'summary' }
		inlineByAgent.set(name, used + 1)
		return { ...nit, placement: 'inline' }
	})
}

/** True when a kept bug is placed inline, so it blocks the verdict. */
export function hasBlockingBug(
	bugs: readonly Pick<PlacedFinding, 'placement'>[]
): boolean {
	return bugs.some(bug => bug.placement === 'inline')
}
