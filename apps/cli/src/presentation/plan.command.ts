import type { PullRequestInfo } from '@mng-review/domain'
import {
	GitServiceLive,
	makeRouterLayer,
	PlanService,
	PlanServiceLive,
	RulesService,
	RulesServiceLive,
	TokenLedgerLive,
} from '@mng-review/engine'
import { Console, Effect, Layer, Option } from 'effect'
import { Command, Flag } from 'effect/cli'
import { CliExit, CONFIG_EXIT_CODE } from './cli-exit.errors'
import { formatPlanJson, formatPlanText } from './plan.formatter'

export const NO_ROUTER_REASON = 'disabled with --no-router'

/** Git, the rules and the token ledger of one CLI run. */
export const SessionLive = RulesServiceLive.pipe(
	Layer.provideMerge(GitServiceLive),
	Layer.provideMerge(TokenLedgerLive)
)

export const planFlags = {
	base: Flag.String('base').pipe(
		Flag.withDescription('Base to compare against, such as main or origin/main')
	),
	head: Flag.String('head').pipe(
		Flag.withDescription('Head commit'),
		Flag.withDefault('HEAD')
	),
	rulesRef: Flag.String('rules-ref').pipe(
		Flag.withDescription(
			'Read .mng/ from this ref instead of the working tree'
		),
		Flag.optional
	),
	labels: Flag.String('label').pipe(
		Flag.withDescription('A pull request label; repeat for more'),
		Flag.atLeast(0)
	),
	author: Flag.String('author').pipe(
		Flag.withDescription('The pull request author'),
		Flag.optional
	),
	target: Flag.String('target').pipe(
		Flag.withDescription(
			'The base branch name; derived from --base by default'
		),
		Flag.optional
	),
	router: Flag.Boolean('router').pipe(
		Flag.withDescription(
			'Ask the router model; --no-router uses path rules only'
		),
		Flag.withDefault(true)
	),
	json: Flag.Boolean('json').pipe(
		Flag.withDescription('Print JSON'),
		Flag.withDefault(false)
	),
} as const

/** Flags of `mng-review plan` after parsing. */
export type PlanFlags = Command.Command.Config.Infer<typeof planFlags>

/** A local run is started by a person, on a branch that is neither a draft nor a fork. */
export function toPullRequestInfo(flags: PlanFlags): PullRequestInfo {
	const author = Option.getOrUndefined(flags.author)
	const target = Option.getOrUndefined(flags.target)
	return {
		labels: flags.labels,
		draft: false,
		fork: false,
		trigger: 'manual',
		...(author === undefined ? {} : { author }),
		...(target === undefined ? {} : { target }),
	}
}

/** Loads the rules, plans the change and prints the plan. */
const runPlan = Effect.fn('planCommand')(function* (flags: PlanFlags) {
	const rules = yield* RulesService.use(service =>
		service.load(Option.getOrUndefined(flags.rulesRef))
	)
	const routerLayer = makeRouterLayer({
		concurrency: rules.config.limits.concurrency,
		...(flags.router ? {} : { disabledReason: NO_ROUTER_REASON }),
	})
	const report = yield* PlanService.use(service =>
		service.plan({
			rules,
			baseRef: flags.base,
			headRef: flags.head,
			pr: toPullRequestInfo(flags),
		})
	).pipe(Effect.provide(PlanServiceLive.pipe(Layer.provide(routerLayer))))
	yield* Console.log(
		flags.json ? formatPlanJson(report) : formatPlanText(report)
	)
})

/** `mng-review plan --base <ref>`: which agents would run, which are skipped and why, and the risk. */
export const planCommand = Command.make('plan', planFlags, flags =>
	runPlan(flags).pipe(
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
).pipe(
	Command.withDescription(
		'Show which agents would run, which are skipped and why, and the risk level, without a review.'
	)
)
