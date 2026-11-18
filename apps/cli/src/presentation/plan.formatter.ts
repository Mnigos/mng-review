import type { ChangedFile, PlannedRun } from '@mng-review/domain'
import type { PlanReport } from '@mng-review/engine'

const SHORT_SHA_LENGTH = 8
const BYTES_PER_KB = 1024

/** Shortens a commit SHA for text output. */
function toShortSha(sha: string): string {
	return sha.slice(0, SHORT_SHA_LENGTH)
}

/** Why a changed file is left out, in words. */
function toFileSkipText(file: ChangedFile): string {
	if (file.skipped === 'too_large')
		return `over max_file_kb, ${Math.ceil(file.sizeBytes / BYTES_PER_KB)} KB`
	return file.skipped ?? ''
}

/** One planned run: name, kind, input, model, effort, file count and what selected it. */
function toRunLine(run: PlannedRun): string {
	const why =
		run.selectedBy === 'router' ? `router: ${run.reason ?? ''}` : run.selectedBy
	return `  ${run.name}  ${run.kind}, ${run.input}, ${run.model} ${run.effort}, ${run.files.length} file(s), ${why}`
}

/** The router line: its rating and additions, or why it did not answer. */
function toRouterText({ plan }: PlanReport): string {
	const { router } = plan
	if (router.status === 'ok')
		return `ok, rated ${router.risk ?? 'normal'}, added ${router.added.length}`
	return `${router.status}${router.detail ? `: ${router.detail}` : ''}`
}

/** Header lines: the refs and the changed files, with the ones left out. */
function toChangeLines({ change, rulesSource }: PlanReport): string[] {
	const left = change.files.filter(file => file.skipped)
	return [
		`Base ${change.base.ref} (${toShortSha(change.base.commit)}), head ${change.head.ref} (${toShortSha(change.head.commit)}), merge base ${toShortSha(change.mergeBase)}`,
		`Rules: ${rulesSource}`,
		`Changed files: ${change.files.length}${left.length > 0 ? `, ${left.length} left out` : ''}`,
		...left.map(file => `  - ${file.path} (${toFileSkipText(file)})`),
	]
}

/** Run and skip lines, then tokens per model when the router spent any. */
function toPlanBodyLines(report: PlanReport): string[] {
	const { plan, tokens } = report
	const riskFrom =
		plan.riskSource === 'risk_paths'
			? `risk_paths: ${plan.riskPathHits.join(', ')}`
			: plan.riskSource
	const tokenEntries = Object.entries(tokens)
	return [
		'',
		`Risk: ${plan.risk} (${riskFrom})`,
		`Depth: ${plan.depth} (${plan.depthSource})`,
		`Router: ${toRouterText(report)}`,
		'',
		`Will run (${plan.runs.length}):`,
		...(plan.runs.length === 0 ? ['  (nothing)'] : plan.runs.map(toRunLine)),
		...(plan.skips.length === 0
			? []
			: [
					'',
					`Skipped (${plan.skips.length}):`,
					...plan.skips.map(skip => `  ${skip.name}  ${skip.reason}`),
				]),
		...(tokenEntries.length === 0
			? []
			: [
					'',
					'Tokens:',
					...tokenEntries.map(
						([model, entry]) =>
							`  ${model}  ${entry.totalTokens} (${entry.inputTokens} in, ${entry.outputTokens} out, ${entry.calls} call(s))`
					),
				]),
	]
}

/** The plan as text: refs, files left out, risk, depth, router, runs, skips and tokens. */
export function formatPlanText(report: PlanReport): string {
	const header = toChangeLines(report)
	if (report.plan.skippedRun)
		return [...header, '', `Run skipped: ${report.plan.skippedRun}`].join('\n')
	return [...header, ...toPlanBodyLines(report)].join('\n')
}

/** The plan as a JSON value. */
export function toPlanJson(report: PlanReport) {
	const { change, plan } = report
	return {
		base: change.base,
		head: change.head,
		mergeBase: change.mergeBase,
		rules: report.rulesSource,
		skipped: plan.skippedRun ?? null,
		risk: {
			level: plan.risk,
			source: plan.riskSource,
			riskPaths: plan.riskPathHits,
		},
		depth: { level: plan.depth, source: plan.depthSource },
		router: plan.router,
		runs: plan.runs,
		skips: plan.skips,
		files: change.files,
		tokens: report.tokens,
	}
}

/** The plan as a JSON document. */
export function formatPlanJson(report: PlanReport): string {
	return JSON.stringify(toPlanJson(report), null, 2)
}
