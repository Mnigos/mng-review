import {
	type ChangedFile,
	type ChangeShape,
	MECHANICAL_MAX_NET_SHARE,
	MECHANICAL_MIN_FILES,
	MECHANICAL_MIN_SMALL_SHARE,
	MECHANICAL_REWRITE_MIN_LINES,
	type PlannedRun,
} from '@mng-review/domain'
import type { PlanReport } from '@mng-review/engine'

const SHORT_SHA_LENGTH = 8
const BYTES_PER_KB = 1024
const PERCENT = 100

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

/** Which rule decided the risk, with the risky paths it saw. */
function toRiskSourceText(plan: PlanReport['plan']): string {
	if (plan.riskSource === 'risk_paths')
		return `risk_paths: ${plan.riskPathHits.join(', ')}`
	if (plan.riskSource === 'mechanical' && plan.riskPathHits.length > 0)
		return `mechanical change, so ${plan.riskPathHits.length} file(s) under risk_paths do not make it risky`
	return plan.riskSource
}

/** A share as a whole percentage. */
function toPercent(share: number): string {
	return `${Math.round(share * PERCENT)}%`
}

/**
 * The change measured against each mechanical condition, with its limit, then the verdict and the
 * conditions it failed. Shown when files under `risk_paths` changed, where the verdict decides.
 */
function toShapeLines(plan: PlanReport['plan']): string[] {
	const { shape } = plan
	if (!shape || plan.riskPathHits.length === 0) return []
	const rewrites = shape.riskyRewrites.length
	const verdict =
		shape.failed.length === 0
			? 'mechanical'
			: `not mechanical, failed: ${shape.failed.join(', ')}`
	return [
		`Change shape: ${shape.files} reviewable file(s) (mechanical needs ${MECHANICAL_MIN_FILES}), ${toPercent(shape.smallShare)} small edits (needs ${toPercent(MECHANICAL_MIN_SMALL_SHARE)}), added and removed lines ${toPercent(shape.netShare)} apart (at most ${toPercent(MECHANICAL_MAX_NET_SHARE)}), ${rewrites} risky file(s) with ${MECHANICAL_REWRITE_MIN_LINES}+ changed lines (needs 0): ${verdict}`,
		...shape.riskyRewrites.map(path => `  - rewrite under risk_paths: ${path}`),
	]
}

/** The shape fields of the plan JSON. */
function toShapeJson(shape: ChangeShape | undefined) {
	if (!shape) return null
	return { ...shape, mechanical: shape.failed.length === 0 }
}

/** Run and skip lines, then tokens per model when the router spent any. */
function toPlanBodyLines(report: PlanReport): string[] {
	const { plan, tokens } = report
	const riskFrom = toRiskSourceText(plan)
	const tokenEntries = Object.entries(tokens)
	return [
		'',
		`Risk: ${plan.risk} (${riskFrom})`,
		...toShapeLines(plan),
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
			shape: toShapeJson(plan.shape),
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
