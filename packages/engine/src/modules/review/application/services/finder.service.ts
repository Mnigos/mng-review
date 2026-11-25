import {
	getReviewableFiles,
	type ModelSetting,
	type PlannedRun,
	parseFindingsAnswer,
	sortFindings,
	toFinding,
} from '@mng-review/domain'
import { Clock, Context, Effect, Layer, Result } from 'effect'
import type { GitError } from '../../../../platform/git/git.errors'
import { GitService } from '../../../../platform/git/git.service'
import { fenceData } from '../../../../utils/fence.util'
import {
	getFirstDiffChars,
	toFinderStatus,
	toRateReport,
	toUnreadReport,
} from '../../domain/finder-budget.helper'
import { toChangeMessage } from '../../domain/finder-message.helper'
import type { AgentRunReport } from '../../domain/review-report.types'
import {
	MAX_FULL_DIFF_CHARS,
	MAX_INCREMENTAL_DIFF_CHARS,
} from '../../domain/review.constants'
import { LoopError } from '../../domain/review.errors'
import type { FinderContext, FinderJob, FinderResult } from '../finder.types'
import { toFindingsCoverage } from '../findings-coverage.helper'
import {
	ALL_REPO_TOOLS,
	METADATA_REPO_TOOLS,
	PrMetadataTool,
} from '../repo.toolkit'
import { ReportFindingsTool } from '../report-findings.tool'
import { toReviewerJobs } from '../reviewer-jobs.helper'
import { FINDING_RULES_PROMPT, NIT_PROMPT } from '../reviewer.prompt'
import { AgentLoopService } from './agent-loop.service'
import { ModelHealthService } from './model-health.service'
import { type RepoScope, RepoToolsService } from './repo-tools.service'

/**
 * Runs one planned finder: the main reviewer (split into units at deep depth) or a declared agent
 * (`kind`, `input` and `max_findings` from its front matter). `jobs` builds its conversations, each
 * main reviewer one with the tokens reading its cut files needs (`need`), so the review can size
 * them before `run` runs them. A job whose model is dropped moves to the next available fallback
 * model. Each job answers with what it has once its tokens run out; a deep review splits into as
 * many units as its share pays for, and `unitPaths` narrows them to the risky ones. A job that
 * answers under its tokens gives the rest to the run's pool, and the main reviewer's conversations
 * claim from it before they wrap up. A job the budget stops before it answers is listed as
 * unfinished and the others' findings stay. `run` never fails: a failure is the report's status.
 */
export class FinderService extends Context.Service<
	FinderService,
	{
		readonly jobs: (
			run: PlannedRun,
			context: FinderContext
		) => Effect.Effect<readonly FinderJob[], LoopError | GitError>
		/** Runs `jobs` when given, else the ones `jobs` builds. */
		readonly run: (
			run: PlannedRun,
			context: FinderContext,
			jobs?: readonly FinderJob[]
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
			// A narrowed reviewer splits only its focus files, so a small share still keeps it to them.
			const narrowed = context.fanOut && context.unitPaths !== undefined
			const diff = yield* readDiff(
				context.scope,
				narrowed ? context.unitPaths : undefined
			)
			return toReviewerJobs({ run, context, diff, narrowed })
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
				// A fallback restarts the conversation, so only a first attempt knows what the job left.
				Effect.tap(result =>
					context.tokens.pool && tried.length === 1
						? context.tokens.pool.release(result.unspentTokens)
						: Effect.void
				),
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
						...(run.role === 'reviewer' && context.tokens.pool
							? { pool: context.tokens.pool }
							: {}),
						...(context.tokens.room ? { room: context.tokens.room } : {}),
						...(job.granted ? { grant: job.granted } : {}),
					},
					source: run.name,
					...(job.coverage
						? { coverage: toFindingsCoverage(job.coverage, job.changed) }
						: {}),
				})
				.pipe(
					Effect.map(result => ({
						unspentTokens: result.unspentTokens,
						model: model.model,
						toolCalls: result.toolCalls,
						continued: result.continued === true,
						tokenRate: result.tokenRate,
						unread: result.unread ?? [],
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

		const jobs = (run: PlannedRun, context: FinderContext) =>
			run.role === 'reviewer'
				? reviewerJobs(run, context)
				: agentJobs(run, context)

		const run = Effect.fn('FinderService.run')(function* (
			planned: PlannedRun,
			context: FinderContext,
			given?: readonly FinderJob[]
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
			const built = yield* Effect.result(
				given ? Effect.succeed(given) : jobs(planned, context)
			)
			if (Result.isFailure(built)) {
				return {
					report: {
						...base,
						status: 'failed',
						error: built.failure.message,
						wallMillis: yield* elapsed,
					},
					findings: [],
				} satisfies FinderResult
			}
			const model = { model: planned.model, effort: planned.effort }
			const results = yield* Effect.forEach(
				built.success,
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
				...(built.success.length > 1 ? { units: built.success.length } : {}),
				...(done.some(entry => entry.continued)
					? { continued: done.filter(entry => entry.continued).length }
					: {}),
				...toUnreadReport(done.flatMap(entry => entry.unread)),
				...toRateReport(
					done.flatMap(entry =>
						entry.tokenRate === undefined ? [] : [entry.tokenRate]
					)
				),
				...(unfinished.length > 0 ? { unfinished } : {}),
				...(firstFailure === undefined
					? {}
					: {
							error:
								built.success.length === 1
									? firstFailure.error.message
									: `${failures.length} of ${built.success.length} units did not finish: ${firstFailure.error.message}`,
						}),
				...(errors.some(error => error._tag === 'LlmError')
					? { endpointError: true }
					: {}),
				wallMillis: yield* elapsed,
			}
			return { report, findings } satisfies FinderResult
		})

		return { jobs, run }
	})
)
