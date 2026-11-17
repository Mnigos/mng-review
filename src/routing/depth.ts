import type { Config } from '../config/schema.ts'
import type { PullRequestInfo } from './context.ts'

export const riskLevels = ['trivial', 'normal', 'risky'] as const
export type Risk = (typeof riskLevels)[number]
export type Depth = 'quick' | 'balanced' | 'deep'

export interface DepthDecision {
  depth: Depth
  /** Why this depth: which rule decided it. */
  source: string
}

const depthForRisk: Record<Risk, Depth> = { trivial: 'quick', normal: 'balanced', risky: 'deep' }

/**
 * Picks the depth. In order: a change under `risk_paths` is always deep; then the deep label, the
 * quick label, a fixed `depth` in `review.yml`, and for `auto` the risk level.
 */
export function resolveDepth(
  config: Config,
  pr: PullRequestInfo,
  risk: Risk,
  riskPathHits: readonly string[],
): DepthDecision {
  if (riskPathHits.length > 0) return { depth: 'deep', source: 'risk_paths' }
  if (pr.labels.includes(config.labels.depth.deep)) {
    return { depth: 'deep', source: `label ${config.labels.depth.deep}` }
  }
  if (pr.labels.includes(config.labels.depth.quick)) {
    return { depth: 'quick', source: `label ${config.labels.depth.quick}` }
  }
  if (config.depth !== 'auto') return { depth: config.depth, source: 'review.yml depth' }
  return { depth: depthForRisk[risk], source: `risk ${risk}` }
}

/** True when the depth is already settled without the router's risk level. */
export function depthIsFixed(config: Config, pr: PullRequestInfo, riskPathHits: readonly string[]) {
  return resolveDepth(config, pr, 'normal', riskPathHits).source !== 'risk normal'
}
