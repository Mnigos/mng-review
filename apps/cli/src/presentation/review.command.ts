import type { PullRequestInfo } from '@mng-review/domain'
import {
	GitService,
	makeReviewLayer,
	makeRouterLayer,
	MAX_AGENT_WALL_TIME,
	MAX_TOOL_CALLS,
	PlanService,
	PlanServiceLive,
	ReviewService,
	RulesService,
	toEmptyReviewReport,
} from '@mng-review/engine'
import { Clock, Console, Effect, Layer, Option } from 'effect'
import { Command, Flag } from 'effect/cli'
import { CliExit, CONFIG_EXIT_CODE } from './cli-exit.errors'
import {
	NO_ROUTER_REASON,
	planFlags,
	SessionLive,
	toPullRequestInfo,
} from './plan.command'
import { formatReviewJson, formatReviewText } from './review.formatter'

/** A bug at or above its severity floor survived validation. */
export const BLOCKING_EXIT_CODE = 1

const reviewFlags = {
	...planFlags,
	title: Flag.String('title').pipe(
		Flag.withDescription('Title of the change, shown to the reviewers'),
		Flag.optional
	),
	body: Flag.String('body').pipe(
		Flag.withDescription('Description of the change'),
		Flag.optional
	),
} as const

/** Flags of `mng-review --base` after parsing. */
type ReviewFlags = Command.Command.Config.Infer<typeof reviewFlags>

/** The pull request of a local run, with its title, description and base branch. */
const toReviewPullRequest = Effect.fn('reviewCommand.toReviewPullRequest')(
	function* (flags: ReviewFlags) {
		const pr: PullRequestInfo = toPullRequestInfo(flags)
		const title = Option.getOrUndefined(flags.title)
		const body = Option.getOrUndefined(flags.body)
		const target =
			pr.target ?? (yield* GitService.use(git => git.branchName(flags.base)))
		return {
			...pr,
			...(title === undefined ? {} : { title }),
			...(body === undefined ? {} : { body }),
			...(target === undefined ? {} : { target }),
		}
	}
)

/** Plans the change, reviews it unless nothing runs, prints the report and exits by its outcome. */
const runReview = Effect.fn('reviewCommand')(function* (flags: ReviewFlags) {
	const startedAt = yield* Clock.currentTimeMillis
	const rules = yield* RulesService.use(service =>
		service.load(Option.getOrUndefined(flags.rulesRef))
	)
	const pr = yield* toReviewPullRequest(flags)
	const { limits } = rules.config
	const routerLayer = makeRouterLayer({
		concurrency: limits.concurrency,
		...(flags.router ? {} : { disabledReason: NO_ROUTER_REASON }),
	})
	const planReport = yield* PlanService.use(service =>
		service.plan({ rules, baseRef: flags.base, headRef: flags.head, pr })
	).pipe(Effect.provide(PlanServiceLive.pipe(Layer.provide(routerLayer))))
	const { plan } = planReport
	const report =
		plan.skippedRun || plan.runs.length === 0
			? toEmptyReviewReport(
					planReport,
					(yield* Clock.currentTimeMillis) - startedAt
				)
			: yield* ReviewService.use(service =>
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
	yield* Console.log(
		flags.json ? formatReviewJson(report) : formatReviewText(report)
	)
	if (report.endpointError)
		return yield* new CliExit({
			code: CONFIG_EXIT_CODE,
			detail: `mng-review: model endpoint error: ${report.endpointError}`,
		})
	if (report.blocking) return yield* new CliExit({ code: BLOCKING_EXIT_CODE })
	return yield* Effect.void
})

/**
 * `mng-review --base <ref>`: reviews the current branch and prints findings. Exits 0 with no bug at
 * or above the severity floor, 1 with one, 2 on a configuration error, a missing endpoint, an
 * endpoint failure of a finder or no reviewer model left.
 */
export const reviewCommand = Command.make('mng-review', reviewFlags, flags =>
	runReview(flags).pipe(
		Effect.provide(SessionLive),
		Effect.catchTag('ConfigError', error =>
			Effect.fail(
				new CliExit({
					code: CONFIG_EXIT_CODE,
					detail: `mng-review: ${error.message}`,
				})
			)
		)
	)
)
