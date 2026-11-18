import type { PlannedRun } from '@mng-review/domain'
import type { AgentRunReport, ReviewReport } from '@mng-review/engine'
import type {
	PullRequestEvent,
	ReviewedRun,
	ShadowOutcome,
} from '../application/shadow-run.types'
import { escapeMarkdown, toCodeSpan, toLogText } from '../utils/markdown.util'
import { toFindingsLines } from './findings-summary.formatter'

export const SUMMARY_TITLE = '## MNG Review (shadow mode)'
const SHORT_SHA_LENGTH = 8
const MILLIS_PER_SECOND = 1000

/** What the summary says about the run besides the outcome. */
export interface SummaryContext {
	/** The commit of the engine that ran, from the reusable workflow. */
	readonly engineCommit: string | undefined
}

/** Milliseconds as seconds with one decimal. */
function toSeconds(millis: number): string {
	return `${(millis / MILLIS_PER_SECOND).toFixed(1)} s`
}

/** A commit SHA shortened, as code. */
function toShortSha(sha: string): string {
	return toCodeSpan(sha.slice(0, SHORT_SHA_LENGTH))
}

/** The verdict the run would post, in one line; stage 4 posts it. */
export function toVerdictLine(report: ReviewReport): string {
	const { plan } = report.planReport
	if (plan.skippedRun) return `skipped: ${plan.skippedRun}`
	if (plan.runs.length === 0) return 'nothing to review'
	if (report.endpointError)
		return `incomplete, the model endpoint failed: ${report.endpointError}`
	const blocking = report.bugs.filter(bug => bug.placement === 'inline').length
	const verdict = report.blocking
		? `needs fixes, ${blocking} bug(s) at or above the severity floor`
		: 'ready, no bug at or above the severity floor'
	return report.incomplete ? `${verdict}; the run is incomplete` : verdict
}

/** The outcome in words, before it is made safe for the log. */
function toLogLine(outcome: ShadowOutcome): string {
	if (outcome.status === 'skipped')
		return `mng-review: skipped: ${outcome.reason}`
	if (outcome.status === 'offline')
		return `mng-review: reviewer offline: ${outcome.reason}`
	if (outcome.status === 'invalid-config')
		return `mng-review: invalid configuration: ${outcome.source}: ${outcome.reason}`
	if (outcome.status === 'failed')
		return `mng-review: failed: ${outcome.reason}`
	return `mng-review: ${toVerdictLine(outcome.report)}`
}

/**
 * The one line the job log gets, without findings. Reasons can carry git output or an endpoint's
 * message, so the line can never act as a workflow command.
 */
export function formatLogLine(outcome: ShadowOutcome): string {
	return toLogText(toLogLine(outcome))
}

/** The pull request and its two commits. */
function toEventLine(event: PullRequestEvent): string {
	return `Pull request #${event.number}, base ${toShortSha(event.baseSha)}, head ${toShortSha(event.headSha)}. Rules from the base commit.`
}

/** Why a planned run runs: the rule or the router's reason. */
function toSelectedBy(run: PlannedRun): string {
	if (run.selectedBy === 'router')
		return `router: ${escapeMarkdown(run.reason ?? '')}`
	return run.selectedBy === 'paths' ? 'path rules' : 'always'
}

/** One table row per planned run, with how its run went. */
function toAgentRow(
	run: PlannedRun,
	agent: AgentRunReport | undefined
): string {
	const status = agent
		? `${agent.status}${agent.error ? `: ${escapeMarkdown(agent.error)}` : ''}`
		: 'not run'
	const model = agent?.fellBackFrom
		? `${agent.model} (for ${agent.fellBackFrom})`
		: (agent?.model ?? run.model)
	return `| ${escapeMarkdown(run.name)} | ${toSelectedBy(run)} | ${escapeMarkdown(model)} ${run.effort} | ${status} | ${agent?.findings ?? 0} | ${agent?.toolCalls ?? 0} | ${agent ? toSeconds(agent.wallMillis) : ''} |`
}

/** Risk, depth and router, then the agents that ran and the ones skipped, each with why. */
function toPlanLines(report: ReviewReport): string[] {
	const { plan } = report.planReport
	const riskPaths =
		plan.riskPathHits.length > 0
			? `: ${escapeMarkdown(plan.riskPathHits.join(', '))}`
			: ''
	const router =
		plan.router.status === 'ok'
			? `rated ${plan.router.risk ?? 'normal'}, added ${plan.router.added.length}`
			: `${plan.router.status}${plan.router.detail ? `, ${escapeMarkdown(plan.router.detail)}` : ''}`
	const agents = new Map(report.agents.map(agent => [agent.name, agent]))
	return [
		'',
		`Risk **${plan.risk}** (${plan.riskSource}${riskPaths}). Depth ${plan.depth} (${escapeMarkdown(plan.depthSource)}). Router: ${router}.`,
		'',
		`### Agents that ran (${plan.runs.length})`,
		'',
		'| Agent | Why | Model | Status | Findings | Tool calls | Time |',
		'| --- | --- | --- | --- | --- | --- | --- |',
		...plan.runs.map(run => toAgentRow(run, agents.get(run.name))),
		...(plan.skips.length === 0
			? []
			: [
					'',
					`### Agents skipped (${plan.skips.length})`,
					'',
					...plan.skips.map(
						skip =>
							`- ${escapeMarkdown(skip.name)}: ${escapeMarkdown(skip.reason)}`
					),
				]),
	]
}

/** Units and agents that did not finish, and models the run stopped using. */
function toUnfinishedLines(report: ReviewReport): string[] {
	const failed = report.agents
		.filter(agent => agent.status === 'failed')
		.map(
			agent =>
				`- ${escapeMarkdown(agent.name)}: failed, ${escapeMarkdown(agent.error ?? '')}`
		)
	const stopped = (report.incomplete?.unfinished ?? []).map(
		entry =>
			`- ${escapeMarkdown(entry)}: ${escapeMarkdown(report.incomplete?.reason ?? '')}`
	)
	const dropped = report.droppedModels.map(
		drop =>
			`- model ${escapeMarkdown(drop.model)} dropped: ${escapeMarkdown(drop.reason)}`
	)
	const lines = [...failed, ...stopped, ...dropped]
	return lines.length === 0 ? [] : ['', '### Did not finish', '', ...lines]
}

/** Tokens per model, router included. */
function toTokenLines(report: ReviewReport): string[] {
	const entries = Object.entries(report.tokens)
	if (entries.length === 0) return []
	return [
		'',
		'### Tokens',
		'',
		'| Model | Total | Input | Cached | Output | Calls |',
		'| --- | ---: | ---: | ---: | ---: | ---: |',
		...entries.map(
			([model, entry]) =>
				`| ${escapeMarkdown(model)} | ${entry.totalTokens} | ${entry.inputTokens} | ${entry.cachedInputTokens} | ${entry.outputTokens} | ${entry.calls} |`
		),
	]
}

/** The body of a reviewed run: verdict, plan, findings, what did not finish and tokens. */
function toReviewedLines(outcome: ReviewedRun): string[] {
	const { report, event } = outcome
	const verdict = `**Verdict, not posted:** ${escapeMarkdown(toVerdictLine(report))}`
	if (
		report.planReport.plan.skippedRun ||
		report.planReport.plan.runs.length === 0
	)
		return [verdict, '', toEventLine(event)]
	return [
		verdict,
		'',
		toEventLine(event),
		...toPlanLines(report),
		...toFindingsLines(report),
		...toUnfinishedLines(report),
		...toTokenLines(report),
		'',
		`Wall time ${toSeconds(report.wallMillis)}.`,
	]
}

/** The body for every outcome. */
function toOutcomeLines(outcome: ShadowOutcome): string[] {
	if (outcome.status === 'skipped')
		return [`Skipped: ${escapeMarkdown(outcome.reason)}.`]
	if (outcome.status === 'offline')
		return [
			`Reviewer offline: ${escapeMarkdown(outcome.reason)}. Nothing was reviewed; the job passes.`,
		]
	if (outcome.status === 'invalid-config')
		return [
			`**Invalid configuration** in ${toCodeSpan(outcome.source)}: ${escapeMarkdown(outcome.reason)}`,
		]
	if (outcome.status === 'failed')
		return [`**Failed:** ${escapeMarkdown(outcome.reason)}`]
	return toReviewedLines(outcome)
}

/**
 * The job summary in GitHub Markdown. Every text that comes from a model, the rules or the pull
 * request is escaped, so it cannot add links, images or HTML to the page.
 */
export function formatSummary(
	outcome: ShadowOutcome,
	context: SummaryContext
): string {
	const engine = context.engineCommit
		? `Engine ${toShortSha(context.engineCommit)}.`
		: 'Engine commit unknown.'
	return [
		SUMMARY_TITLE,
		'',
		...toOutcomeLines(outcome),
		'',
		`Shadow mode: nothing is posted to the pull request. ${engine}`,
		'',
	].join('\n')
}
