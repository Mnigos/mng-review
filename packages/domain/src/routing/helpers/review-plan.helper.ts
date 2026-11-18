import { getAgentSettings, raiseEffort } from '../../agents/agent.helper'
import type { DeclaredAgent } from '../../agents/agent.types'
import type { ChangedFile } from '../../change/change.types'
import { getReviewableFiles } from '../../change/file-skip.helper'
import type {
	Plan,
	PlanInput,
	PlannedRun,
	PlannedSkip,
	PlanRouting,
} from '../review-plan.types'
import { REVIEWER_NAME, REVIEWER_TITLE } from '../routing.constants'
import type { Depth, Risk, RouterReport } from '../routing.types'
import { getRiskPathHits, selectByRules } from './agent-selection.helper'
import { resolveDepth } from './depth.helper'
import { gateRun, isFeatureActive } from './run-gate.helper'

const QUICK_DEPTH_REASON = 'depth quick runs metadata agents only'

/** What every run and skip of one plan is decided from. */
interface PlanContext {
	readonly input: PlanInput
	readonly router: RouterReport
	readonly reviewable: readonly ChangedFile[]
	readonly depth: Depth
}

/** Runs and skips of a plan, in order. */
interface PlanEntries {
	readonly runs: PlannedRun[]
	readonly skips: PlannedSkip[]
}

/** A router report for a run that does not ask the router. */
function skippedRouter(detail: string): RouterReport {
	return { status: 'skipped', detail, added: [] }
}

/**
 * Whether the engine asks the router model. Never for a skipped run or a change without reviewable
 * files; otherwise the candidates are the enabled agents that failed only on paths and have a
 * triage line. The router is asked even without candidates, for the risk level.
 */
export function getPlanRouting(input: PlanInput): PlanRouting {
	const { config, agents, files, pr } = input
	if (gateRun(config, pr))
		return { status: 'skip', router: skippedRouter('run skipped') }
	const reviewable = getReviewableFiles(files)
	if (reviewable.length === 0)
		return { status: 'skip', router: skippedRouter('no reviewable files') }
	const candidates = isFeatureActive(config.features.agents, config, pr)
		? agents.filter(agent => {
				const selection = selectByRules(agent, files, pr)
				return !selection.selected && selection.routable
			})
		: []
	return { status: 'route', candidates, files: reviewable }
}

/** Why an agent that only the router could add does not run. */
function getRouterSkipReason(router: RouterReport): string {
	if (router.status === 'ok')
		return 'no changed file matches when.paths; the router did not add it'
	return `no changed file matches when.paths; router ${router.status}`
}

/** Why the main reviewer does not run, or `undefined` when it runs. */
function getReviewerSkipReason(context: PlanContext): string | undefined {
	const { config, pr } = context.input
	if (!isFeatureActive(config.features.reviewer, config, pr))
		return `features.reviewer is ${config.features.reviewer}`
	if (context.reviewable.length === 0) return 'no reviewable files'
	if (context.depth === 'quick') return QUICK_DEPTH_REASON
	return undefined
}

/** One main reviewer run on the first reviewer model; at deep depth one per model, effort raised. */
function planReviewer(context: PlanContext, entries: PlanEntries): void {
	const reason = getReviewerSkipReason(context)
	if (reason) {
		entries.skips.push({ name: REVIEWER_NAME, title: REVIEWER_TITLE, reason })
		return
	}
	const deep = context.depth === 'deep'
	const { reviewer } = context.input.config.models
	for (const entry of deep ? reviewer : reviewer.slice(0, 1))
		entries.runs.push({
			name: REVIEWER_NAME,
			title: REVIEWER_TITLE,
			role: 'reviewer',
			kind: 'bug',
			input: 'incremental',
			model: entry.model,
			effort: deep ? raiseEffort(entry.effort) : entry.effort,
			files: context.reviewable.map(file => file.path),
			selectedBy: 'default',
		})
}

/** Why a declared agent does not run, or its run. */
function planAgent(
	agent: DeclaredAgent,
	context: PlanContext
): PlannedRun | PlannedSkip {
	const { config, files, pr } = context.input
	const skip = (reason: string) => ({
		name: agent.name,
		title: agent.title,
		reason,
	})
	if (!isFeatureActive(config.features.agents, config, pr))
		return skip(`features.agents is ${config.features.agents}`)
	const { frontMatter } = agent
	const selection = selectByRules(agent, files, pr)
	const routerReason =
		!selection.selected && selection.routable
			? context.router.added.find(entry => entry.agent === agent.name)?.reason
			: undefined
	if (!selection.selected && routerReason === undefined)
		return skip(
			selection.routable
				? getRouterSkipReason(context.router)
				: selection.reason
		)
	if (context.depth === 'quick' && frontMatter.input !== 'metadata')
		return skip(QUICK_DEPTH_REASON)
	const settings = getAgentSettings(agent, config)
	const raised =
		context.depth === 'deep' &&
		frontMatter.kind === 'bug' &&
		frontMatter.effort === undefined
	return {
		name: agent.name,
		title: agent.title,
		role: 'agent',
		kind: frontMatter.kind,
		input: frontMatter.input,
		model: settings.model,
		effort: raised ? raiseEffort(settings.effort) : settings.effort,
		files: selection.files,
		selectedBy: selection.selected
			? frontMatter.when.paths.length > 0
				? 'paths'
				: 'default'
			: 'router',
		...(routerReason === undefined ? {} : { reason: routerReason }),
	}
}

/**
 * Builds the plan from its inputs and the router's report, or the skip report from
 * `getPlanRouting`. The router adds agents and rates the risk; it never removes an agent. A change
 * under `risk_paths` is risky whatever the router says, and without a rating the risk is `normal`,
 * or `trivial` when no file is reviewable.
 */
export function buildPlan(input: PlanInput, router: RouterReport): Plan {
	const { config, agents, files, pr } = input
	const riskPathHits = getRiskPathHits(files, config.risk_paths)
	const skippedRun = gateRun(config, pr)
	if (skippedRun)
		return {
			skippedRun,
			files,
			risk: 'normal',
			riskSource: 'default',
			riskPathHits,
			depth: resolveDepth(config, pr, 'normal', riskPathHits).depth,
			depthSource: 'run skipped',
			router: skippedRouter('run skipped'),
			runs: [],
			skips: [],
		}
	const reviewable = getReviewableFiles(files)
	const fallbackRisk: Risk = reviewable.length > 0 ? 'normal' : 'trivial'
	const routerRisk = router.status === 'ok' ? router.risk : undefined
	const risk: Risk =
		riskPathHits.length > 0 ? 'risky' : (routerRisk ?? fallbackRisk)
	const { depth, source } = resolveDepth(config, pr, risk, riskPathHits)
	const context: PlanContext = { input, router, reviewable, depth }
	const entries: PlanEntries = { runs: [], skips: [] }
	planReviewer(context, entries)
	for (const agent of agents) {
		const entry = planAgent(agent, context)
		if ('role' in entry) entries.runs.push(entry)
		else entries.skips.push(entry)
	}
	return {
		skippedRun: undefined,
		files,
		risk,
		riskSource:
			riskPathHits.length > 0
				? 'risk_paths'
				: routerRisk
					? 'router'
					: 'default',
		riskPathHits,
		depth,
		depthSource: source,
		router,
		...entries,
	}
}
