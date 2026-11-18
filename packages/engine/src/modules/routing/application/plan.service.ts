import {
	applyFileSkips,
	buildPlan,
	getPlanRouting,
	type PlanInput,
	type PullRequestInfo,
	type ConfigError,
} from '@mng-review/domain'
import { Context, Effect, Layer } from 'effect'
import type { Rules } from '../../../platform/config/rules.service'
import type { GitError } from '../../../platform/git/git.errors'
import { GitService } from '../../../platform/git/git.service'
import { TokenLedger } from '../../../platform/llm/token-ledger.service'
import type { PlanReport } from '../domain/plan-report.types'
import { RouterService } from './router.service'

/** What a plan is asked for: the rules, the refs and what is known about the pull request. */
export interface PlanRequest {
	readonly rules: Rules
	readonly baseRef: string
	readonly headRef: string
	/** Without a `target`, the base ref's branch name is used. */
	readonly pr: PullRequestInfo
}

/**
 * Builds the plan of a run: reads the change, marks skipped files, selects agents by their
 * `when` rules, asks the router about the rest and the risk, and picks the depth.
 */
export class PlanService extends Context.Service<
	PlanService,
	{
		readonly plan: (
			request: PlanRequest
		) => Effect.Effect<PlanReport, ConfigError | GitError>
	}
>()('mng-review/PlanService') {}

export const PlanServiceLive = Layer.effect(
	PlanService,
	Effect.gen(function* () {
		const git = yield* GitService
		const router = yield* RouterService
		const ledger = yield* TokenLedger

		const plan = Effect.fn('PlanService.plan')(function* (
			request: PlanRequest
		) {
			const { config, agents, source } = request.rules
			const change = yield* git.readChange(request.baseRef, request.headRef)
			const target =
				request.pr.target ?? (yield* git.branchName(request.baseRef))
			const files = applyFileSkips(change.files, config)
			const input: PlanInput = {
				config,
				agents,
				files,
				pr: target === undefined ? request.pr : { ...request.pr, target },
			}
			const routing = getPlanRouting(input)
			const report =
				routing.status === 'skip'
					? routing.router
					: yield* router.route({
							change,
							files: routing.files,
							candidates: routing.candidates,
							model: config.models.router,
						})
			return {
				change: { ...change, files },
				plan: buildPlan(input, report),
				rulesSource: source,
				tokens: yield* ledger.snapshot,
			}
		})

		return { plan }
	})
)
