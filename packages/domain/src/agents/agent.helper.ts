import { Effect } from 'effect'
import { ConfigError } from '../config/config.errors'
import type { Effort, ReviewConfig } from '../config/review-config.schema'
import { RAISED_EFFORT } from './agent.constants'
import type { AgentFile, AgentSettings, DeclaredAgent } from './agent.types'

/** Settings for one declared agent: its front matter over `models.agents` and `comments`. */
export function getAgentSettings(
	agent: Pick<DeclaredAgent, 'frontMatter'>,
	config: ReviewConfig
): AgentSettings {
	const { frontMatter } = agent
	return {
		model: frontMatter.model ?? config.models.agents.model,
		effort: frontMatter.effort ?? config.models.agents.effort,
		comments: { ...config.comments, ...frontMatter.comments },
	}
}

/** One step more effort for a deep run; never above `high` unless it already is `xhigh`. */
export function raiseEffort(effort: Effort): Effort {
	return RAISED_EFFORT[effort]
}

/** Completes an agent file with its expanded instructions; an agent without instructions fails. */
export function toDeclaredAgent(
	agentFile: AgentFile,
	expandedBody: string
): Effect.Effect<DeclaredAgent, ConfigError> {
	const { body: _body, ...agent } = agentFile
	const instructions = expandedBody.trim()
	if (!instructions)
		return Effect.fail(
			new ConfigError({
				source: agentFile.file,
				reason: 'the agent has no instructions',
			})
		)
	return Effect.succeed({ ...agent, instructions })
}
