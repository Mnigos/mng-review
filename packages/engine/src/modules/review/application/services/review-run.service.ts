import {
	type ConfigError,
	type PullRequestInfo,
	toAgentOnlyPlan,
	toIncrementalPlan,
	toUnknownAgentPlan,
} from '@mng-review/domain'
import { Clock, Context, Effect, Layer } from 'effect'
import type { Rules } from '../../../../platform/config/rules.service'
import { SAFE_DIFF } from '../../../../platform/git/git.constants'
import type { GitError } from '../../../../platform/git/git.errors'
import { GitService } from '../../../../platform/git/git.service'
import { TokenLedger } from '../../../../platform/llm/token-ledger.service'
import { RaterService } from '../../../risk/application/rater.service'
import { isRatingRun } from '../../../risk/domain/risk-rating.helper'
import { makeRaterLayer } from '../../../risk/infrastructure/risk.layers'
import {
	PlanService,
	PlanServiceLive,
} from '../../../routing/application/plan.service'
import type { PlanReport } from '../../../routing/domain/plan-report.types'
import { makeRouterLayer } from '../../../routing/infrastructure/router.layers'
import { toEmptyReviewReport } from '../../domain/review-report.helper'
import type { ReviewReport } from '../../domain/review-report.types'
import {
	MAX_AGENT_WALL_TIME,
	MAX_TOOL_CALLS,
} from '../../domain/review.constants'
import { makeReviewLayer } from '../../infrastructure/review.layers'
import type { ReviewLimits } from '../review-limits.context'
import { ReviewService } from './review.service'

/** One review of a change: the loaded rules, the two refs and what is known about the pull request. */
export interface ReviewRunRequest {
	readonly rules: Rules
	readonly baseRef: string
	readonly headRef: string
	readonly pr: PullRequestInfo
	/** Set to plan without the router model; the plan names this reason. */
	readonly routerDisabledReason?: string
	/**
	 * The commit an earlier run reviewed. When it is an ancestor of the head, agents with
	 * `input: incremental` review only the files changed since; otherwise it is ignored.
	 */
	readonly since?: string
	/**
	 * A declared agent a command named: only it runs, on every reviewable file if its rules skip it.
	 * A name the rules do not declare skips the run without a model call.
	 */
	readonly onlyAgent?: string
}

/**
 * The plan narrowed to the files changed since an earlier review, when that commit is an ancestor
 * of the head and differs from it; the plan unchanged otherwise, or when git cannot tell.
 */
const toIncrementalReport = Effect.fn('ReviewRunService.toIncrementalReport')(
	function* (report: PlanReport, since: string | undefined) {
		const head = report.change.head.commit
		if (!since || since === head || report.plan.skippedRun) return report
		const git = yield* GitService
		const ancestor = yield* git
			.exec(['merge-base', '--is-ancestor', since, head])
			.pipe(Effect.option)
		if (ancestor._tag === 'None' || ancestor.value.exitCode !== 0) return report
		const changed = yield* git
			.exec(['diff', '--name-only', '-z', ...SAFE_DIFF, since, head])
			.pipe(Effect.option)
		if (changed._tag === 'None' || changed.value.exitCode !== 0) return report
		const paths = new Set(changed.value.stdout.split('\0').filter(Boolean))
		return { ...report, plan: toIncrementalPlan(report.plan, paths, since) }
	}
)

/** Why the router does not run when a command names an agent the rules do not declare. */
const UNKNOWN_AGENT_ROUTER_REASON = 'a command named an undeclared agent'

/**
 * The plan narrowed to the agent a command named, or skipped when the rules do not declare it; a
 * plan the gate already skipped, or a request that names no agent, is left as it is.
 */
function toRequestedReport(
	report: PlanReport,
	request: ReviewRunRequest
): PlanReport {
	const { onlyAgent, rules } = request
	if (onlyAgent === undefined || report.plan.skippedRun) return report
	const agent = rules.agents.find(entry => entry.name === onlyAgent)
	return {
		...report,
		plan: agent
			? toAgentOnlyPlan(report.plan, agent, rules.config)
			: toUnknownAgentPlan(report.plan, onlyAgent),
	}
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
		const unknownAgent =
			request.onlyAgent !== undefined &&
			!rules.agents.some(entry => entry.name === request.onlyAgent)
		const disabledReason = unknownAgent
			? UNKNOWN_AGENT_ROUTER_REASON
			: request.routerDisabledReason
		const routerLayer = makeRouterLayer({
			concurrency: limits.concurrency,
			...(disabledReason === undefined ? {} : { disabledReason }),
		})
		const planned = yield* PlanService.use(service =>
			service.plan({
				rules,
				baseRef: request.baseRef,
				headRef: request.headRef,
				pr,
			})
		).pipe(Effect.provide(PlanServiceLive.pipe(Layer.provide(routerLayer))))
		const incremental = yield* toIncrementalReport(planned, request.since)
		const planReport = toRequestedReport(incremental, request)
		const { plan } = planReport
		const reviewLimits = {
			concurrency: limits.concurrency,
			tokensPerRun: limits.tokens_per_run,
			maxFileKb: limits.max_file_kb,
			maxToolCalls: MAX_TOOL_CALLS,
			maxWallTime: MAX_AGENT_WALL_TIME,
		} satisfies ReviewLimits['Service']
		const report =
			plan.skippedRun || plan.runs.length === 0
				? toEmptyReviewReport(
						planReport,
						(yield* Clock.currentTimeMillis) - startedAt
					)
				: yield* ReviewService.use(service =>
						service.review({ rules, planReport, pr, startedAt })
					).pipe(Effect.provide(makeReviewLayer(reviewLimits)))
		if (!isRatingRun({ config: rules.config, plan, ...request })) return report
		return yield* rateReport(report, request, reviewLimits, startedAt)
	}
)

/**
 * The report with the rating of its change: the rater over the complete change after the review,
 * on the same token ledger, so the report's tokens and wall time include it.
 */
const rateReport = Effect.fn('ReviewRunService.rateReport')(function* (
	report: ReviewReport,
	request: ReviewRunRequest,
	limits: ReviewLimits['Service'],
	startedAt: number
) {
	const { planReport } = report
	const rating = yield* RaterService.use(service =>
		service.rate({
			rules: request.rules,
			change: planReport.change,
			pr: request.pr,
			plan: planReport.plan,
			review: report,
		})
	).pipe(Effect.provide(makeRaterLayer(limits)))
	const ledger = yield* TokenLedger
	return {
		...report,
		rating,
		tokens: yield* ledger.snapshot,
		tokenSources: yield* ledger.sources,
		wallMillis: (yield* Clock.currentTimeMillis) - startedAt,
	} satisfies ReviewReport
})

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
