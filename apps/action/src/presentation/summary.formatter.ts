import {
	MECHANICAL_MAX_NET_SHARE,
	MECHANICAL_MIN_FILES,
	MECHANICAL_MIN_SMALL_SHARE,
	MECHANICAL_REWRITE_MIN_LINES,
	type PlannedRun,
} from '@mng-review/domain'
import type { AgentRunReport, ReviewReport } from '@mng-review/engine'
import {
	escapeMarkdown,
	getAgentReport,
	type SweepResult,
	toCodeSpan,
	toLogText,
} from '@mng-review/github'
import type { PublishReport } from '../application/publish-run.service'
import type {
	PullRequestEvent,
	ReviewedRun,
	ShadowOutcome,
} from '../application/shadow-run.types'
import { toFindingsLines } from './findings-summary.formatter'

export const SUMMARY_TITLE = '## MNG Review (shadow mode)'
export const PUBLISH_SUMMARY_TITLE = '## MNG Review (publish mode)'
export const SWEEP_SUMMARY_TITLE = '## MNG Review (status sweep)'
const SHORT_SHA_LENGTH = 8
const MILLIS_PER_SECOND = 1000
const PERCENT = 100

/** What the summary says about the run besides the outcome. */
export interface SummaryContext {
	/** The commit of the engine that ran, from the reusable workflow. */
	readonly engineCommit: string | undefined
	/** Set in publish mode: what was posted on the pull request. */
	readonly publish?: PublishReport
}

/** Milliseconds as seconds with one decimal. */
function toSeconds(millis: number): string {
	return `${(millis / MILLIS_PER_SECOND).toFixed(1)} s`
}

/** A commit SHA shortened, as code. */
function toShortSha(sha: string): string {
	return toCodeSpan(sha.slice(0, SHORT_SHA_LENGTH))
}

/** The verdict in one line: incomplete, as the posted verdict is, when an agent failed or stopped and nothing blocks. */
export function toVerdictLine(report: ReviewReport): string {
	const { plan } = report.planReport
	if (plan.skippedRun) return `skipped: ${plan.skippedRun}`
	if (plan.runs.length === 0) return 'nothing to review'
	if (report.endpointError)
		return `incomplete, the model endpoint failed: ${report.endpointError}`
	const blocking = report.bugs.filter(bug => bug.placement === 'inline').length
	if (report.blocking)
		return `needs fixes, ${blocking} bug(s) at or above the severity floor${report.incomplete ? '; the run is incomplete' : ''}`
	const unfinished = report.agents.filter(agent => agent.status !== 'ok')
	if (unfinished.length > 0)
		return `incomplete, ${unfinished.length} agent(s) did not finish; no bug at or above the severity floor so far`
	const verdict = 'ready, no bug at or above the severity floor'
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

/** A share as a whole percentage. */
function toPercent(share: number): string {
	return `${Math.round(share * PERCENT)}%`
}

/**
 * The change measured against each mechanical condition and its limit, and whether files under
 * `risk_paths` sat in a mechanical change; nothing when no such file changed.
 */
function toShapeText(plan: ReviewReport['planReport']['plan']): string {
	const { shape } = plan
	if (!shape || plan.riskPathHits.length === 0) return ''
	const verdict =
		shape.failed.length === 0
			? 'mechanical change'
			: `not mechanical, failed: ${shape.failed.join(', ')}`
	return `; ${shape.files} files (mechanical needs ${MECHANICAL_MIN_FILES}), ${toPercent(shape.smallShare)} small edits (needs ${toPercent(MECHANICAL_MIN_SMALL_SHARE)}), lines ${toPercent(shape.netShare)} apart (at most ${toPercent(MECHANICAL_MAX_NET_SHARE)}), ${shape.riskyRewrites.length} risky rewrite(s) of ${MECHANICAL_REWRITE_MIN_LINES}+ lines: ${verdict}`
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
	return [
		'',
		`Risk **${plan.risk}** (${plan.riskSource}${riskPaths}${toShapeText(plan)}). Depth ${plan.depth} (${escapeMarkdown(plan.depthSource)}). Router: ${router}.`,
		'',
		`### Agents that ran (${plan.runs.length})`,
		'',
		'| Agent | Why | Model | Status | Findings | Tool calls | Time |',
		'| --- | --- | --- | --- | --- | --- | --- |',
		...plan.runs.map(run =>
			toAgentRow(run, getAgentReport(run, report.agents))
		),
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
function toReviewedLines(outcome: ReviewedRun, posted: boolean): string[] {
	const { report, event } = outcome
	const label = posted ? 'This run' : 'Verdict, not posted'
	const verdict = `**${label}:** ${escapeMarkdown(toVerdictLine(report))}`
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
function toOutcomeLines(outcome: ShadowOutcome, posted: boolean): string[] {
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
	return toReviewedLines(outcome, posted)
}

/** What publish mode did on the pull request, in one line of plain text. */
function toPublishText(report: PublishReport): string {
	if (report.status === 'failed') return `publishing failed: ${report.reason}`
	if (report.status === 'not-published')
		return `nothing posted: ${report.reason}`
	if (report.status === 'status-only')
		return report.posted
			? 'posted the offline status as the summary comment'
			: 'kept the existing summary comment; the reviewer was offline'
	const { result, checks } = report
	return `posted run ${result.run}: verdict ${result.verdict}, ${result.openBugs} open bug thread(s); new threads: ${result.onLine} on lines, ${result.onFile} on files, ${result.inSummary} in the summary comment, ${result.unposted} not posted; ${result.repeated} already had a thread, ${result.dismissed} found again under resolved threads; ${result.resolved} of ${result.rechecked} rechecked thread(s) resolved; ${checks.checks} check run(s), status ${checks.status ? 'set' : 'not set'}`
}

/** The publish line of the job log; a GitHub message in it can never act as a workflow command. */
export function formatPublishLogLine(report: PublishReport): string {
	return toLogText(`mng-review: ${toPublishText(report)}`)
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
	if (context.publish)
		return [
			PUBLISH_SUMMARY_TITLE,
			'',
			...toOutcomeLines(outcome, true),
			'',
			`Publish mode: ${escapeMarkdown(toPublishText(context.publish))}. ${engine}`,
			'',
		].join('\n')
	return [
		SUMMARY_TITLE,
		'',
		...toOutcomeLines(outcome, false),
		'',
		`Shadow mode: nothing is posted to the pull request. ${engine}`,
		'',
	].join('\n')
}

/** What the status sweep did, in words. */
export function formatSweepLine(result: SweepResult): string {
	return `status sweep: ${result.checked} pull request(s) carry the status, ${result.updated} updated, ${result.failed} failed`
}

/** The job summary of a status sweep. */
export function formatSweepSummary(line: string): string {
	return [SWEEP_SUMMARY_TITLE, '', escapeMarkdown(line), ''].join('\n')
}
