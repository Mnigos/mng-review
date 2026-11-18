import { deepMerge } from '../config/merge.ts'
import type { Config, Effort } from '../config/schema.ts'
import type { DeclaredAgent } from './parse.ts'

export interface AgentSettings {
  model: string
  effort: Effort
  comments: Config['comments']
}

/** Settings for one declared agent: its front matter over `review.yml`. */
export function agentSettings(agent: DeclaredAgent, config: Config): AgentSettings {
  const fm = agent.frontMatter
  const base = config.models.agents
  return {
    model: fm.model ?? base.model,
    effort: fm.effort ?? base.effort,
    comments: deepMerge(config.comments, fm.comments ?? {}),
  }
}

/** One step more effort, never above `high` unless it already is. Used on a deep run. */
export function raiseEffort(effort: Effort): Effort {
  if (effort === 'minimal') return 'low'
  if (effort === 'low') return 'medium'
  return effort === 'xhigh' ? 'xhigh' : 'high'
}
