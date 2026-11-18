import {
	decideOutcome,
	hasBlockingBug,
	mergeFindings,
	type PullRequestInfo,
} from '@mng-review/domain'
import { Clock, Context, Effect, Layer } from 'effect'
import type { Rules } from '../../../../platform/config/rules.service'
import { TokenLedger } from '../../../../platform/llm/token-ledger.service'
import type { PlanReport } from '../../../routing/domain/plan-report.types'
import { ValidatorService } from '../../../validation/application/validator.service'
import type { ReviewReport } from '../../domain/review-report.types'
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
 * Finds, validates and places the findings of a planned run. The main reviewer and the selected
 * agents run at once; bug findings with the same root cause merge, each merged bug is validated
 * once, then the severity floor and the nit caps place them. A dropped model is reported; with no
 * reviewer model left, or a finder that failed at the endpoint, the report carries `endpointError`.
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
			const results = yield* Effect.forEach(
				plan.runs,
				run =>
					finder.run(run, {
						scope,
						rules,
						fanOut: plan.depth === 'deep',
						fallback: run.role === 'reviewer' ? reviewerFallback : reviewers,
					}),
				{ concurrency: 'unbounded' }
			)
			const found = results.flatMap(result => result.findings)
			const bugs = mergeFindings(found.filter(entry => entry.kind === 'bug'))
			const nits = mergeFindings(found.filter(entry => entry.kind === 'nit'))
			const validations = yield* Effect.forEach(
				bugs,
				bug => validator.validate(bug, { scope, config, rules }),
				{ concurrency: 'unbounded' }
			)
			const outcome = decideOutcome({
				bugs,
				validations,
				nits,
				config,
				agents: new Map(rules.agents.map(agent => [agent.name, agent])),
			})
			const droppedModels = yield* health.dropped
			const agents = results.map(result => result.report)
			const failed = agents.find(agent => agent.endpointError)
			const noReviewerLeft = reviewers.every(entry =>
				droppedModels.some(drop => drop.model === entry.model)
			)
			const endpointError = noReviewerLeft
				? `no reviewer model left: ${droppedModels.map(drop => `${drop.model} ${drop.reason}`).join('; ')}`
				: failed && `${failed.name}: ${failed.error ?? 'endpoint error'}`
			return {
				...outcome,
				planReport,
				agents,
				tokens: yield* ledger.snapshot,
				droppedModels,
				wallMillis: (yield* Clock.currentTimeMillis) - request.startedAt,
				...(endpointError ? { endpointError } : {}),
				blocking: hasBlockingBug(outcome.bugs),
			} satisfies ReviewReport
		})

		return { review }
	})
)
