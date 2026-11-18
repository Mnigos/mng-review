import {
	addLaterFindings,
	getReviewableFiles,
	type ModelSetting,
	type ParsedFindings,
	type PlannedRun,
	parseFindingsAnswer,
	sortFindings,
	splitReviewUnits,
	toFinding,
} from '@mng-review/domain'
import { Clock, Context, Effect, Layer, Result } from 'effect'
import { GitService } from '../../../../platform/git/git.service'
import { fenceData } from '../../../../utils/fence.util'
import {
	getFirstDiffChars,
	getUnitCount,
	getUnitsToReview,
	toFinderStatus,
} from '../../domain/finder-budget.helper'
import {
	toChangeMessage,
	toContextNotes,
	toUnitMessage,
} from '../../domain/finder-message.helper'
import type { AgentRunReport } from '../../domain/review-report.types'
import {
	MAX_FULL_DIFF_CHARS,
	MAX_INCREMENTAL_DIFF_CHARS,
} from '../../domain/review.constants'
import { LoopError } from '../../domain/review.errors'
import type { LoopCoverage } from '../agent-loop.types'
import type { FinderContext, FinderJob, FinderResult } from '../finder.types'
import {
	ALL_REPO_TOOLS,
	METADATA_REPO_TOOLS,
	PrMetadataTool,
} from '../repo.toolkit'
import { ReportFindingsTool } from '../report-findings.tool'
import {
	FINDING_RULES_PROMPT,
	NIT_PROMPT,
	REVIEWER_PROMPT,
	UNIT_PROMPT,
} from '../reviewer.prompt'
import { AgentLoopService } from './agent-loop.service'
import { ModelHealthService } from './model-health.service'
import { type RepoScope, RepoToolsService } from './repo-tools.service'

/**
 * The main reviewer's method check: the changed files it must read before it answers. A
 * continuation adds only findings that do not repeat the first answer's.
 */
export function toFindingsCoverage(
	paths: readonly string[]
): LoopCoverage<ParsedFindings> {
	return {
		paths,
		answered: value => value.findings.map(entry => entry.path),
		merge: addLaterFindings,
	}
}

/**
 * Runs one planned finder: the main reviewer (split into units at deep depth) or a declared agent
 * (`kind`, `input` and `max_findings` from its front matter). A job whose model is dropped moves to
 * the next available fallback model. Each job answers with what it has once its share of the run's
 * planned tokens runs out (`tokens`); a deep review splits into as many units as its share pays
 * for, and `unitPaths` narrows them to the risky ones. A job the budget stops before it answers is listed as
 * unfinished and the others' findings stay. It never fails: a failure is the report's status.
 */
export class FinderService extends Context.Service<
	FinderService,
	{
		readonly run: (
			run: PlannedRun,
			context: FinderContext
		) => Effect.Effect<FinderResult>
	}
>()('mng-review/FinderService') {}

export const FinderServiceLive = Layer.effect(
	FinderService,
	Effect.gen(function* () {
		const git = yield* GitService
		const loop = yield* AgentLoopService
		const health = yield* ModelHealthService
		const repoTools = yield* RepoToolsService

		/** The diff of the given files, or of every reviewable file. */
		const readDiff = (scope: RepoScope, paths?: readonly string[]) => {
			const reviewable = getReviewableFiles(scope.change.files)
			const files = paths
				? reviewable.filter(file => paths.includes(file.path))
				: reviewable
			return git.readDiff(scope.change, files)
		}

		const reviewerJobs = Effect.fn('FinderService.reviewerJobs')(function* (
			run: PlannedRun,
			context: FinderContext
		) {
			const { pr } = context.scope
			const system = [
				REVIEWER_PROMPT,
				...toContextNotes(context.rules.context),
				FINDING_RULES_PROMPT,
			].join('\n\n')
			const diff = yield* readDiff(context.scope)
			const { allowance } = context.tokens
			const split = context.fanOut
				? splitReviewUnits(diff, getUnitCount(allowance))
				: []
			const units = getUnitsToReview(split, context.unitPaths)
			if (split.length > 0 && units.length === 0) return []
			if (split.length > 1) {
				const tokens = Math.floor(allowance / Math.max(1, units.length))
				return units.map(unit => ({
					unit: unit.label,
					system: `${system}\n\n${UNIT_PROMPT}`,
					user: toUnitMessage({
						unit,
						files: context.scope.change.files,
						pr,
						maxChars: getFirstDiffChars(tokens, MAX_INCREMENTAL_DIFF_CHARS),
					}),
					tools: ALL_REPO_TOOLS,
					tokens,
					coverage: unit.paths,
				}))
			}
			return [
				{
					system,
					user: toChangeMessage({
						files: context.scope.change.files,
						scope: run.files,
						pr,
						diff,
						maxChars: getFirstDiffChars(allowance, MAX_FULL_DIFF_CHARS),
					}),
					tools: ALL_REPO_TOOLS,
					tokens: allowance,
					coverage: getReviewableFiles(context.scope.change.files)
						.map(file => file.path)
						.filter(path => run.files.includes(path)),
				},
			]
		})

		const agentJobs = Effect.fn('FinderService.agentJobs')(function* (
			run: PlannedRun,
			context: FinderContext
		) {
			const agent = context.rules.agents.find(entry => entry.name === run.name)
			if (!agent)
				return yield* new LoopError({
					reason: `agent ${run.name} is not loaded`,
				})
			const intro =
				run.kind === 'nit'
					? NIT_PROMPT
					: `You are a review agent: ${agent.title}. Find bugs in your area, described below.`
			const system = [intro, agent.instructions, FINDING_RULES_PROMPT].join(
				'\n\n'
			)
			const { pr } = context.scope
			if (run.input === 'metadata') {
				const metadata = yield* repoTools.call(
					context.scope,
					PrMetadataTool.name,
					{}
				)
				return [
					{
						system,
						user: fenceData('Change metadata:', metadata),
						tools: METADATA_REPO_TOOLS,
						tokens: context.tokens.allowance,
					},
				]
			}
			const full = run.input === 'full_diff'
			const diff = yield* readDiff(context.scope, full ? undefined : run.files)
			return [
				{
					system,
					user: toChangeMessage({
						files: context.scope.change.files,
						scope: run.files,
						pr,
						diff,
						maxChars: getFirstDiffChars(
							context.tokens.allowance,
							full ? MAX_FULL_DIFF_CHARS : MAX_INCREMENTAL_DIFF_CHARS
						),
					}),
					tools: ALL_REPO_TOOLS,
					tokens: context.tokens.allowance,
				},
			]
		})

		/** The next fallback model that is neither tried nor dropped. */
		const nextModel = (context: FinderContext, tried: readonly string[]) =>
			health.dropped.pipe(
				Effect.map(dropped =>
					context.fallback?.find(
						entry =>
							!tried.includes(entry.model) &&
							!dropped.some(drop => drop.model === entry.model)
					)
				)
			)

		const runJob = (
			run: PlannedRun,
			job: FinderJob,
			context: FinderContext,
			model: ModelSetting,
			tried: readonly string[]
		): ReturnType<typeof attemptJob> =>
			attemptJob(run, job, context, model).pipe(
				Effect.catchTag('ModelDroppedError', error =>
					nextModel(context, tried).pipe(
						Effect.flatMap(next =>
							next
								? runJob(run, job, context, next, [...tried, next.model])
								: Effect.fail(error)
						)
					)
				)
			)

		const attemptJob = (
			run: PlannedRun,
			job: FinderJob,
			context: FinderContext,
			model: ModelSetting
		) =>
			loop
				.run({
					model,
					system: job.system,
					user: job.user,
					scope: context.scope,
					tools: job.tools,
					finish: ReportFindingsTool.name,
					parse: parseFindingsAnswer,
					budget: {
						runTokens: context.tokens.runTokens,
						conversationTokens: job.tokens,
					},
					source: run.name,
					...(job.coverage
						? { coverage: toFindingsCoverage(job.coverage) }
						: {}),
				})
				.pipe(
					Effect.map(result => ({
						model: model.model,
						toolCalls: result.toolCalls,
						continued: result.continued === true,
						malformed: result.value.dropped,
						findings: result.value.findings.map(reported =>
							toFinding(reported, {
								agent: run.name,
								kind: run.kind,
								model: model.model,
							})
						),
					}))
				)

		const run = Effect.fn('FinderService.run')(function* (
			planned: PlannedRun,
			context: FinderContext
		) {
			const started = yield* Clock.currentTimeMillis
			const base = {
				name: planned.name,
				title: planned.title,
				kind: planned.kind,
				model: planned.model,
				effort: planned.effort,
				toolCalls: 0,
				findings: 0,
				malformed: 0,
			}
			const elapsed = Clock.currentTimeMillis.pipe(
				Effect.map(now => now - started)
			)
			const jobs = yield* Effect.result(
				planned.role === 'reviewer'
					? reviewerJobs(planned, context)
					: agentJobs(planned, context)
			)
			if (Result.isFailure(jobs)) {
				return {
					report: {
						...base,
						status: 'failed',
						error: jobs.failure.message,
						wallMillis: yield* elapsed,
					},
					findings: [],
				} satisfies FinderResult
			}
			const model = { model: planned.model, effort: planned.effort }
			const results = yield* Effect.forEach(
				jobs.success,
				(job: FinderJob) =>
					Effect.result(
						runJob(planned, job, context, model, [model.model])
					).pipe(Effect.map(result => ({ job, result }))),
				{ concurrency: 'unbounded' }
			)
			const done = results.flatMap(({ result }) =>
				Result.isSuccess(result) ? [result.success] : []
			)
			const failures = results.flatMap(({ job, result }) =>
				Result.isFailure(result) ? [{ job, error: result.failure }] : []
			)
			const unfinished = failures
				.filter(entry => entry.error._tag === 'TokenBudgetError')
				.map(entry => entry.job.unit ?? planned.name)
			const errors = failures
				.filter(entry => entry.error._tag !== 'TokenBudgetError')
				.map(entry => entry.error)
			const used = [...new Set(done.map(entry => entry.model))]
			const found = done.flatMap(entry => entry.findings)
			const maxFindings = context.rules.agents.find(
				agent => agent.name === planned.name
			)?.frontMatter.max_findings
			const findings =
				planned.role === 'agent' && maxFindings !== undefined
					? sortFindings(found).slice(0, maxFindings)
					: found
			const endpointFailure = failures.find(
				entry => entry.error._tag === 'LlmError'
			)
			const firstFailure = endpointFailure ?? failures[0]
			const failedAll = done.length === 0 && errors.length > 0
			const report: AgentRunReport = {
				...base,
				...(used.length > 0 && !used.includes(planned.model)
					? { model: used.join(', '), fellBackFrom: planned.model }
					: {}),
				status: toFinderStatus(failedAll, unfinished.length),
				toolCalls: done.reduce((sum, entry) => sum + entry.toolCalls, 0),
				malformed: done.reduce((sum, entry) => sum + entry.malformed, 0),
				findings: findings.length,
				...(jobs.success.length > 1 ? { units: jobs.success.length } : {}),
				...(done.some(entry => entry.continued)
					? { continued: done.filter(entry => entry.continued).length }
					: {}),
				...(unfinished.length > 0 ? { unfinished } : {}),
				...(firstFailure === undefined
					? {}
					: {
							error:
								jobs.success.length === 1
									? firstFailure.error.message
									: `${failures.length} of ${jobs.success.length} units did not finish: ${firstFailure.error.message}`,
						}),
				...(errors.some(error => error._tag === 'LlmError')
					? { endpointError: true }
					: {}),
				wallMillis: yield* elapsed,
			}
			return { report, findings } satisfies FinderResult
		})

		return { run }
	})
)
