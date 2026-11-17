import { deepMerge } from '../config/merge.ts'
import type { Config, Effort } from '../config/schema.ts'
import type { DeclaredAgent } from './parse.ts'

export interface AgentSettings {
  model: string
  effort: Effort
  comments: Config['comments']
  maxFileKb: number
}

/** Settings for one declared agent: its front matter over `review.yml`. */
export function agentSettings(agent: DeclaredAgent, config: Config): AgentSettings {
  const fm = agent.frontMatter
  const base = agent.frontMatter.kind === 'bug' ? config.models.reviewer : config.models.nits
  return {
    model: fm.model ?? base.model,
    effort: fm.effort ?? base.effort,
    comments: deepMerge(config.comments, fm.comments ?? {}),
    maxFileKb: fm.limits?.max_file_kb ?? config.limits.max_file_kb,
  }
}

/** One step more effort, capped at `high`. Used for bug finders on a deep run. */
export function raiseEffort(effort: Effort): Effort {
  if (effort === 'minimal') return 'low'
  if (effort === 'low') return 'medium'
  return effort === 'xhigh' ? 'xhigh' : 'high'
}
