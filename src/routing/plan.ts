import type { DeclaredAgent } from '../agents/parse.ts'
import type { AgentInput } from '../agents/schema.ts'
import { agentSettings, raiseEffort } from '../agents/settings.ts'
import { type ChangedFile, reviewableFiles } from '../change/change.ts'
import type { Config, Effort } from '../config/schema.ts'
import { featureActive, gateRun, type PullRequestInfo } from './context.ts'
import { type Depth, type Risk, resolveDepth } from './depth.ts'
import type { RouterAddition, RouterInput, RouterOutcome } from './router.ts'
import { type RuleSelection, riskPathHits, selectByRules } from './select.ts'

export interface PlannedRun {
  /** `reviewer` for the main reviewer, otherwise the agent's file name. */
  name: string
  title: string
  role: 'reviewer' | 'agent'
  kind: 'bug' | 'nit'
  input: AgentInput
  model: string
  effort: Effort
  files: string[]
  selectedBy: 'default' | 'paths' | 'router'
  /** `default`: the main reviewer or an agent without `when.paths`. */
  /** The router's reason when it added the agent. */
  reason?: string
}

export interface PlannedSkip {
  name: string
  title: string
  reason: string
}

export interface RouterReport {
  status: 'ok' | 'failed' | 'skipped'
  detail?: string
  risk?: Risk
  added: RouterAddition[]
}

export interface Plan {
  /** Set when the whole run is skipped. */
  skippedRun: string | null
  files: ChangedFile[]
  risk: Risk
  riskSource: 'risk_paths' | 'router' | 'default'
  riskPathHits: string[]
  depth: Depth
  depthSource: string
  router: RouterReport
  runs: PlannedRun[]
  skips: PlannedSkip[]
}

export interface PlanInput {
  config: Config
  agents: DeclaredAgent[]
  /** Changed files with skips already applied. */
  files: ChangedFile[]
  pr: PullRequestInfo
  /** Calls the router model; null when no endpoint is available. */
  route: ((input: RouterInput) => Promise<RouterOutcome>) | null
  /** Why `route` is null, for the report. */
  routeUnavailable?: string
  diff: () => Promise<string>
}

export const reviewerTitle = 'Main reviewer'

export async function buildPlan(input: PlanInput): Promise<Plan> {
  const { config, agents, files, pr } = input
  const skippedRun = gateRun(config, pr)
  const hits = riskPathHits(files, config.risk_paths)
  if (skippedRun) {
    return {
      skippedRun,
      files,
      risk: 'normal',
      riskSource: 'default',
      riskPathHits: hits,
      depth: resolveDepth(config, pr, 'normal', hits).depth,
      depthSource: 'run skipped',
      router: { status: 'skipped', detail: 'run skipped', added: [] },
      runs: [],
      skips: [],
    }
  }

  const reviewable = reviewableFiles(files)
  const agentsOn = featureActive(config.features.agents, config, pr)
  const selections = new Map<string, RuleSelection>(
    agents.map(agent => [agent.name, selectByRules(agent, files, pr)]),
  )
  const candidates = agentsOn
    ? agents.filter(agent => {
        const selection = selections.get(agent.name)
        return selection && !selection.selected && selection.routable
      })
    : []

  const router = await consultRouter(input, reviewable, candidates)
  const risk: Risk =
    hits.length > 0 ? 'risky' : (router.risk ?? (reviewable.length ? 'normal' : 'trivial'))
  const riskSource = hits.length > 0 ? 'risk_paths' : router.risk ? 'router' : 'default'
  const { depth, source: depthSource } = resolveDepth(config, pr, risk, hits)

  const runs: PlannedRun[] = []
  const skips: PlannedSkip[] = []
  const reviewerSkip = !featureActive(config.features.reviewer, config, pr)
    ? `features.reviewer is ${config.features.reviewer}`
    : reviewable.length === 0
      ? 'no reviewable files'
      : depth === 'quick'
        ? 'depth quick runs metadata agents only'
        : null
  if (reviewerSkip) {
    skips.push({ name: 'reviewer', title: reviewerTitle, reason: reviewerSkip })
  } else {
    const base = config.models.reviewer
    runs.push({
      name: 'reviewer',
      title: reviewerTitle,
      role: 'reviewer',
      kind: 'bug',
      input: 'incremental',
      model: base.model,
      effort: depth === 'deep' ? raiseEffort(base.effort) : base.effort,
      files: reviewable.map(file => file.path),
      selectedBy: 'default',
    })
  }

  const added = new Map(router.added.map(addition => [addition.agent, addition.reason]))
  for (const agent of agents) {
    const skip = (reason: string) => skips.push({ name: agent.name, title: agent.title, reason })
    if (!agentsOn) {
      skip(`features.agents is ${config.features.agents}`)
      continue
    }
    const selection = selections.get(agent.name)!
    const reason = added.get(agent.name)
    if (!selection.selected && reason === undefined) {
      skip(selection.routable ? routerSkipReason(router) : selection.reason)
      continue
    }
    if (depth === 'quick' && agent.frontMatter.input !== 'metadata') {
      skip('depth quick runs metadata agents only')
      continue
    }
    const settings = agentSettings(agent, config)
    const deepBug = depth === 'deep' && agent.frontMatter.kind === 'bug'
    runs.push({
      name: agent.name,
      title: agent.title,
      role: 'agent',
      kind: agent.frontMatter.kind,
      input: agent.frontMatter.input,
      model: settings.model,
      effort: deepBug && !agent.frontMatter.effort ? raiseEffort(settings.effort) : settings.effort,
      files: selection.files,
      selectedBy: !selection.selected
        ? 'router'
        : agent.frontMatter.when.paths.length > 0
          ? 'paths'
          : 'default',
      ...(selection.selected ? {} : { reason }),
    })
  }

  return {
    skippedRun: null,
    files,
    risk,
    riskSource,
    riskPathHits: hits,
    depth,
    depthSource,
    router,
    runs,
    skips,
  }
}

async function consultRouter(
  input: PlanInput,
  reviewable: ChangedFile[],
  candidates: DeclaredAgent[],
): Promise<RouterReport> {
  if (reviewable.length === 0) {
    return { status: 'skipped', detail: 'no reviewable files', added: [] }
  }
  if (!input.route) {
    return { status: 'failed', detail: input.routeUnavailable ?? 'no model endpoint', added: [] }
  }
  try {
    const outcome = await input.route({
      files: reviewable,
      diff: await input.diff(),
      candidates: candidates.map(agent => ({
        name: agent.name,
        title: agent.title,
        triage: agent.frontMatter.when.triage ?? '',
      })),
    })
    if (outcome.status === 'failed') return { status: 'failed', detail: outcome.error, added: [] }
    return { status: 'ok', risk: outcome.risk, added: outcome.added }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { status: 'failed', detail, added: [] }
  }
}

function routerSkipReason(router: RouterReport): string {
  if (router.status === 'ok') return 'no changed file matches when.paths; the router did not add it'
  return `no changed file matches when.paths; router ${router.status}`
}
