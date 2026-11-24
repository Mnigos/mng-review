import {
	decideOutcome,
	getFocusPaths,
	getFocusShare,
	getPlannedTokens,
	getReviewableFiles,
	toRunAllowances,
	hasBlockingBug,
	mergeFindings,
	type PlannedRun,
	type PullRequestInfo,
} from '@mng-review/domain'
import { Clock, Context, Effect, Layer, Result } from 'effect'
import type { Rules } from '../../../../platform/config/rules.service'
import { TokenLedger } from '../../../../platform/llm/token-ledger.service'
import type { PlanReport } from '../../../routing/domain/plan-report.types'
import { ValidatorService } from '../../../validation/application/validator.service'
import { getValidationTokens } from '../../domain/finder-budget.helper'
import { makeTokenPool } from '../../domain/loop-budget.helper'
import { toIncompleteRun } from '../../domain/review-report.helper'
import type { ReviewReport } from '../../domain/review-report.types'
import { FINDER_TOKEN_SHARE } from '../../domain/review.constants'
import type { FinderContext } from '../finder.types'
import { ReviewLimits } from '../review-limits.context'
import { toSizedJobs } from '../reviewer-jobs.helper'
import { FinderService } from './finder.service'
import { ModelHealthService } from './model-health.service'

/** A planned run to review: the rules, the plan and the pull request it was made for. */
export interface ReviewRequest {
	readonly rules: Rules
	readonly planReport: PlanReport
	readonly pr: PullRequestInfo
	/** When the run started, in epoch milliseconds, so the wall time covers the plan too. */
	readonly startedAt: number
}

/**
 * Finds, validates and places the findings of a planned run. The run plans to spend
 * `limits.tokens_by_depth` for its depth (never more than `limits.tokens_per_run`):
 * `FINDER_TOKEN_SHARE` of it split over the finders by weight, the rest over the validations; what a
 * finder leaves unspent goes to the main reviewer's conversations. Each main reviewer conversation
 * then gets what reading every changed file its first message cuts needs (`toSizedJobs`), and the
 * run plans that much more, while the finders together stay within `FINDER_TOKEN_SHARE` of
 * `limits.tokens_per_run`; past that every grant is cut alike and the report says so (`capped`). At
 * deep depth under `risk_paths`, or when the router's signals made the change risky, reviewer models
 * after the first review only the units of those files and plan tokens for their changed lines
 * (`getFocusShare`). The main reviewer and the selected
 * agents run at once; bug findings with the same root cause merge, each merged bug is validated
 * once, then the severity floor and the nit caps place them. A dropped model is reported; with no
 * reviewer model left after finding, or a finder that failed at the endpoint, the report carries
 * `endpointError`. Models dropped while validating are reported but never fail the run. Finders
 * and validations the token budget stopped mark the report `incomplete`; the rest of it stays.
 */
export class ReviewService extends Context.Service<
	ReviewService,
	{ readonly review: (request: ReviewRequest) => Effect.Effect<ReviewReport> }
>()('mng-review/ReviewService') {}

export const ReviewServiceLive = Layer.effect(
	ReviewService,
	Effect.gen(function* () {
		const finder = yield* FinderService
		const validator = yield* ValidatorService
		const health = yield* ModelHealthService
		const ledger = yield* TokenLedger
		const limits = yield* ReviewLimits

		const review = Effect.fn('ReviewService.review')(function* (
			request: ReviewRequest
		) {
			const { rules, planReport, pr } = request
			const { config } = rules
			const { plan, change } = planReport
			const scope = { change, pr }
			const reviewers = config.models.reviewer
			const reviewerRuns = plan.runs.filter(run => run.role === 'reviewer')
			// With several reviewer models finding on their own, a dropped one is not replaced.
			const reviewerFallback = reviewerRuns.length > 1 ? undefined : reviewers
			const plannedTokens = getPlannedTokens(config.limits, plan.depth)
			const runTokens = Math.floor(plannedTokens * FINDER_TOKEN_SHARE)
			const allowances = toRunAllowances(plan.runs, runTokens)
			const [firstReviewer] = reviewerRuns
			const pool = yield* makeTokenPool
			const focusPaths = getFocusPaths(plan)
			const focusShare = getFocusShare(
				getReviewableFiles(change.files),
				focusPaths
			)
			/** A later reviewer model at deep depth reviews only the focus files. */
			const isNarrowed = (run: PlannedRun) =>
				run.role === 'reviewer' &&
				run !== firstReviewer &&
				focusPaths.length > 0
			const entries = plan.runs.map((run, index) => {
				const allowance = allowances[index] ?? 0
				const narrowed = isNarrowed(run)
				const context: FinderContext = {
					scope,
					rules,
					fanOut: plan.depth === 'deep',
					fallback: run.role === 'reviewer' ? reviewerFallback : reviewers,
					tokens: {
						allowance: narrowed
							? Math.floor(allowance * focusShare)
							: allowance,
						runTokens,
						pool,
					},
					...(narrowed ? { unitPaths: focusPaths } : {}),
				}
				return { run, context }
			})
			const built = yield* Effect.forEach(
				entries,
				entry => Effect.result(finder.jobs(entry.run, entry.context)),
				{ concurrency: 'unbounded' }
			)
			const finderCap = Math.floor(
				config.limits.tokens_per_run * FINDER_TOKEN_SHARE
			)
			const sized = toSizedJobs(
				built.map(jobs => (Result.isSuccess(jobs) ? jobs.success : undefined)),
				finderCap - runTokens
			)
			const results = yield* Effect.forEach(
				entries,
				({ run, context }, index) =>
					finder.run(
						run,
						{
							...context,
							tokens: {
								...context.tokens,
								runTokens: runTokens + sized.granted,
							},
						},
						sized.jobs[index]
					),
				{ concurrency: 'unbounded' }
			)
			const found = results.flatMap(result => result.findings)
			const bugs = mergeFindings(found.filter(entry => entry.kind === 'bug'))
			const nits = mergeFindings(found.filter(entry => entry.kind === 'nit'))
			const droppedWhileFinding = yield* health.dropped
			const sizedTokens = plannedTokens + sized.granted
			const budget = {
				runTokens: sizedTokens,
				conversationTokens: getValidationTokens(
					sizedTokens - (yield* health.spent),
					bugs.length
				),
			}
			const validated = yield* validator.validateAll(bugs, {
				scope,
				config,
				rules,
				budget,
			})
			const { validations } = validated
			const outcome = decideOutcome({
				bugs: validated.bugs,
				validations,
				nits,
				config,
				agents: new Map(rules.agents.map(agent => [agent.name, agent])),
			})
			const droppedModels = yield* health.dropped
			const agents = results.map(result => result.report)
			const failed = agents.find(agent => agent.endpointError)
			const noReviewerLeft = reviewers.every(entry =>
				droppedWhileFinding.some(drop => drop.model === entry.model)
			)
			const endpointError = noReviewerLeft
				? `no reviewer model left: ${droppedWhileFinding.map(drop => `${drop.model} ${drop.reason}`).join('; ')}`
				: failed && `${failed.name}: ${failed.error ?? 'endpoint error'}`
			const incomplete = toIncompleteRun({
				agents,
				validations,
				tokensPerRun: limits.tokensPerRun,
			})
			return {
				...outcome,
				planReport,
				agents,
				tokens: yield* ledger.snapshot,
				tokenSources: yield* ledger.sources,
				droppedModels,
				wallMillis: (yield* Clock.currentTimeMillis) - request.startedAt,
				...(endpointError ? { endpointError } : {}),
				...(incomplete ? { incomplete } : {}),
				...(sized.capped
					? { capped: { needed: runTokens + sized.needed, cap: finderCap } }
					: {}),
				blocking: hasBlockingBug(outcome.bugs),
			} satisfies ReviewReport
		})

		return { review }
	})
)
