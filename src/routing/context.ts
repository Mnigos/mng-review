import type { Config, FeatureMode } from '../config/schema.ts'

/** What the engine knows about the pull request, or about the local branch from the CLI. */
export interface PullRequestInfo {
  author?: string
  labels: string[]
  /** Base branch name, e.g. `main`. */
  target?: string
  title?: string
  body?: string
  draft: boolean
  fork: boolean
  /** `manual`: started by a person (CLI, command); `auto`: started by an event. */
  trigger: 'auto' | 'manual'
}

export function hasAnyLabel(pr: PullRequestInfo, labels: readonly string[]): string | undefined {
  return pr.labels.find(label => labels.includes(label))
}

/** Whole-run skip rules. Returns the reason to skip, or null to go on. */
export function gateRun(config: Config, pr: PullRequestInfo): string | null {
  const forced = hasAnyLabel(pr, config.labels.always_review)
  if (config.skip.forks && pr.fork) return 'fork pull request (skip.forks)'
  if (pr.author && config.skip.authors.includes(pr.author)) {
    return `author ${pr.author} is in skip.authors`
  }
  if (pr.target && config.skip.targets.includes(pr.target)) {
    return `target branch ${pr.target} is in skip.targets`
  }
  if (forced) return null
  if (config.skip.drafts && pr.draft) return 'draft pull request (skip.drafts)'
  const label = hasAnyLabel(pr, config.skip.labels)
  if (label) return `label ${label} is in skip.labels`
  return null
}

/** Whether a feature runs for this trigger; `manual` needs a manual trigger or an always_review label. */
export function featureActive(mode: FeatureMode, config: Config, pr: PullRequestInfo): boolean {
  if (mode === 'always') return true
  if (mode === 'off') return false
  return pr.trigger === 'manual' || hasAnyLabel(pr, config.labels.always_review) !== undefined
}
