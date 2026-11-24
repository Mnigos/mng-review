import { CommandAnswerService, GitHubStatusService } from '@mng-review/github'
import { Effect, Layer } from 'effect'
import { RiskRunService } from '../../application/risk-run.service'

/**
 * The rating as a run with `risk.enabled` off sees it: every publish runs without a rating block
 * and the report says `off`. Specs of the rating itself use the real service.
 */
export const RiskRunOffLayer = Layer.succeed(RiskRunService, {
	rateFull: (_gate, _input, publish) =>
		publish(undefined).pipe(
			Effect.map(value => ({ value, risk: { status: 'off' } as const }))
		),
	rateThread: () => Effect.succeed({ status: 'off' } as const),
	readAnswers: () => Effect.succeed([]),
})

/** The cap and denial rules as a run with `risk.enabled` off sees them: the decision stands. */
export const CommandAnswerOffLayer = Layer.succeed(CommandAnswerService, {
	check: input => Effect.succeed(input.decision),
	post: () => Effect.succeed(false),
})

/** The sweep's pull request list with `risk.enabled` off: never asked, so every call dies. */
export const RiskSweepOffLayer = Layer.succeed(GitHubStatusService, {
	createCheckRun: () => Effect.die('the risk pass is off'),
	setStatus: () => Effect.die('the risk pass is off'),
	getStatus: () => Effect.die('the risk pass is off'),
	listOpenPullRequests: () => Effect.die('the risk pass is off'),
})
