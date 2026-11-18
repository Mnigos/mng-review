import type { ConfigError, PullRequestInfo } from '@mng-review/domain'
import { Clock, Context, Effect, Layer } from 'effect'
import type { Rules } from '../../../../platform/config/rules.service'
import type { GitError } from '../../../../platform/git/git.errors'
import {
	PlanService,
	PlanServiceLive,
} from '../../../routing/application/plan.service'
import { makeRouterLayer } from '../../../routing/infrastructure/router.layers'
import { toEmptyReviewReport } from '../../domain/review-report.helper'
import type { ReviewReport } from '../../domain/review-report.types'
import {
	MAX_AGENT_WALL_TIME,
	MAX_TOOL_CALLS,
} from '../../domain/review.constants'
import { makeReviewLayer } from '../../infrastructure/review.layers'
import { ReviewService } from './review.service'

/** One review of a change: the loaded rules, the two refs and what is known about the pull request. */
export interface ReviewRunRequest {
	readonly rules: Rules
	readonly baseRef: string
	readonly headRef: string
	readonly pr: PullRequestInfo
	/** Set to plan without the router model; the plan names this reason. */
	readonly routerDisabledReason?: string
}

/**
 * Plans the change and reviews it unless the gate skipped it or nothing is planned. The router and
 * the review pipeline are built from the rules' `limits`, on the endpoint from the environment.
 * The CLI, the GitHub workflow entry and the benchmark run a review through this one function.
 */
export const reviewChange = Effect.fn('ReviewRunService.reviewChange')(
	function* (request: ReviewRunRequest) {
		const startedAt = yield* Clock.currentTimeMillis
		const { rules, pr } = request
		const { limits } = rules.config
		const routerLayer = makeRouterLayer({
			concurrency: limits.concurrency,
			...(request.routerDisabledReason === undefined
				? {}
				: { disabledReason: request.routerDisabledReason }),
		})
		const planReport = yield* PlanService.use(service =>
			service.plan({
				rules,
				baseRef: request.baseRef,
				headRef: request.headRef,
				pr,
			})
		).pipe(Effect.provide(PlanServiceLive.pipe(Layer.provide(routerLayer))))
		const { plan } = planReport
		if (plan.skippedRun || plan.runs.length === 0)
			return toEmptyReviewReport(
				planReport,
				(yield* Clock.currentTimeMillis) - startedAt
			)
		return yield* ReviewService.use(service =>
			service.review({ rules, planReport, pr, startedAt })
		).pipe(
			Effect.provide(
				makeReviewLayer({
					concurrency: limits.concurrency,
					tokensPerRun: limits.tokens_per_run,
					maxFileKb: limits.max_file_kb,
					maxToolCalls: MAX_TOOL_CALLS,
					maxWallTime: MAX_AGENT_WALL_TIME,
				})
			)
		)
	}
)

/** Services a review takes from its caller: git, the token ledger, the HTTP client and the environment. */
export type ReviewRunServices = Effect.Services<ReturnType<typeof reviewChange>>

/** Plans and reviews one change; see `reviewChange`. */
export class ReviewRunService extends Context.Service<
	ReviewRunService,
	{
		readonly run: (
			request: ReviewRunRequest
		) => Effect.Effect<ReviewReport, ConfigError | GitError>
	}
>()('mng-review/ReviewRunService') {}

export const ReviewRunServiceLive = Layer.effect(
	ReviewRunService,
	Effect.gen(function* () {
		const services = yield* Effect.context<ReviewRunServices>()

		const run = Effect.fn('ReviewRunService.run')(function* (
			request: ReviewRunRequest
		) {
			return yield* reviewChange(request).pipe(Effect.provideContext(services))
		})

		return { run }
	})
)
