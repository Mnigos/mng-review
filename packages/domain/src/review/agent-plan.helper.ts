import { AGENT_NAME_PATTERN } from '../agents/agent.constants'
import { getAgentSettings } from '../agents/agent.helper'
import type { DeclaredAgent } from '../agents/agent.types'
import type { ReviewConfig } from '../config/review-config.schema'
import type { Plan, PlannedRun } from '../routing/review-plan.types'

/** Why every other run is left out when a command names one agent. */
const OTHER_RUNS_REASON = 'a command asked for another agent'

/**
 * The plan when a command names one declared agent: only that agent runs, on every reviewable file
 * when its `when` rules did not select it, and every other planned run is skipped with the reason.
 */
export function toAgentOnlyPlan(
	plan: Plan,
	agent: DeclaredAgent,
	config: ReviewConfig
): Plan {
	const planned = plan.runs.filter(run => run.name === agent.name)
	const settings = getAgentSettings(agent, config)
	const runs: PlannedRun[] =
		planned.length > 0
			? planned
			: [
					{
						name: agent.name,
						title: agent.title,
						role: 'agent',
						kind: agent.frontMatter.kind,
						input: agent.frontMatter.input,
						model: settings.model,
						effort: settings.effort,
						files: plan.files
							.filter(file => !file.skipped)
							.map(file => file.path),
						selectedBy: 'default',
						reason: 'requested by a command',
					},
				]
	const others = plan.runs
		.filter(run => run.name !== agent.name)
		.filter(
			(run, index, all) =>
				all.findIndex(other => other.name === run.name) === index
		)
		.map(run => ({
			name: run.name,
			title: run.title,
			reason: OTHER_RUNS_REASON,
		}))
	return { ...plan, runs, skips: [...plan.skips, ...others] }
}

/**
 * The plan when a command names an agent the rules do not declare: the run is skipped, so a
 * mistyped name never turns into a full review. Only a name that could be declared is repeated in
 * the reason, so the reason never carries the command's other text.
 */
export function toUnknownAgentPlan(plan: Plan, name: string): Plan {
	const named = AGENT_NAME_PATTERN.test(name) ? `agent ${name}` : 'an agent'
	return {
		...plan,
		skippedRun: `a command named ${named}, which the rules do not declare`,
		runs: [],
		skips: [],
	}
}
