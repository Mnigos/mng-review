import type { DeclaredAgent } from '../agents/parse.ts'
import type { ChangedFile } from '../change/change.ts'
import type { PullRequestInfo } from './context.ts'
import { matchesAny } from './glob.ts'

export type RuleSelection =
  | { selected: true; files: string[] }
  | {
      selected: false
      reason: string
      /** True when only the path rule failed, so the router may still add the agent. */
      routable: boolean
      /** Files the agent would review if the router adds it. */
      files: string[]
    }

/**
 * Applies an agent's `when` rules. Each non-empty list must match: `labels` any PR label,
 * `authors` the author, `targets` the base branch, `paths` at least one reviewable file that no
 * `exclude` pattern matches. An agent with no `paths` covers every file; a metadata agent with no
 * `paths` runs even when no file is reviewable.
 */
export function selectByRules(
  agent: DeclaredAgent,
  files: ChangedFile[],
  pr: PullRequestInfo,
): RuleSelection {
  const when = agent.frontMatter.when
  if (when.labels.length > 0 && !pr.labels.some(label => when.labels.includes(label))) {
    return { selected: false, reason: 'no label from when.labels', routable: false, files: [] }
  }
  if (when.authors.length > 0 && !(pr.author && when.authors.includes(pr.author))) {
    return { selected: false, reason: 'author not in when.authors', routable: false, files: [] }
  }
  if (when.targets.length > 0 && !(pr.target && when.targets.includes(pr.target))) {
    return {
      selected: false,
      reason: 'target branch not in when.targets',
      routable: false,
      files: [],
    }
  }
  const inScope = files
    .filter(file => !file.skipped && !matchesAny(file.path, when.exclude))
    .map(file => file.path)
  const touches = (path: string) =>
    matchesAny(path, when.paths) ||
    files.some(file => file.path === path && file.oldPath && matchesAny(file.oldPath, when.paths))
  if (when.paths.length === 0) {
    if (inScope.length > 0 || agent.frontMatter.input === 'metadata') {
      return { selected: true, files: inScope }
    }
    return { selected: false, reason: 'no reviewable file in scope', routable: false, files: [] }
  }
  const matched = inScope.filter(touches)
  if (matched.length > 0) return { selected: true, files: matched }
  return {
    selected: false,
    reason: 'no changed file matches when.paths',
    routable: inScope.length > 0 && when.triage !== undefined,
    files: inScope,
  }
}

/** Reviewable files under `risk_paths`, matched at their new or, for a rename, old path. */
export function riskPathHits(files: ChangedFile[], riskPaths: readonly string[]): string[] {
  if (riskPaths.length === 0) return []
  return files
    .filter(file => !file.skipped)
    .filter(
      file =>
        matchesAny(file.path, riskPaths) ||
        (file.oldPath !== undefined && matchesAny(file.oldPath, riskPaths)),
    )
    .map(file => file.path)
}
