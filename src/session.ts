import { loadAgents, type DeclaredAgent } from './agents/parse.ts'
import {
  applyFileSkips,
  type Change,
  readChange,
  readDiff,
  reviewableFiles,
} from './change/change.ts'
import { loadConfig } from './config/load.ts'
import type { Config } from './config/schema.ts'
import { Git } from './git/git.ts'
import type { LlmClient } from './llm/types.ts'
import { gitRefReader, type RepoReader, worktreeReader } from './repo/reader.ts'
import type { PullRequestInfo } from './routing/context.ts'
import { buildPlan, type Plan } from './routing/plan.ts'
import { runRouter } from './routing/router.ts'

export interface SessionOptions {
  cwd: string
  base: string
  head?: string
  /** Read `.mng/` from this ref; by default from the working tree. */
  rulesRef?: string
  pr: PullRequestInfo
}

/** Everything a run needs, read once: repository, rules, agents and the change. */
export interface Session {
  git: Git
  rules: RepoReader
  config: Config
  agents: DeclaredAgent[]
  change: Change
  pr: PullRequestInfo
}

export async function openSession(options: SessionOptions): Promise<Session> {
  const git = await Git.open(options.cwd)
  const rules = options.rulesRef
    ? gitRefReader(git, options.rulesRef, await git.resolveCommit(options.rulesRef))
    : worktreeReader(git.root)
  const [config, agents] = await Promise.all([loadConfig(rules), loadAgents(rules)])
  const change = await readChange(git, options.base, options.head ?? 'HEAD')
  change.files = applyFileSkips(change.files, config)
  return { git, rules, config, agents, change, pr: options.pr }
}

export interface PlanOptions {
  /** Model client for the router; null runs path selection only. */
  llm: LlmClient | null
  llmUnavailable?: string
}

export function planSession(session: Session, options: PlanOptions): Promise<Plan> {
  const { config, change, git, agents, pr } = session
  const llm = options.llm
  return buildPlan({
    config,
    agents,
    files: change.files,
    pr,
    route: llm ? input => runRouter(llm, config.models.router, input) : null,
    ...(options.llmUnavailable ? { routeUnavailable: options.llmUnavailable } : {}),
    diff: () =>
      readDiff(
        git,
        change,
        reviewableFiles(change.files).map(file => file.path),
      ),
  })
}
