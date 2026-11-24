import { RulesService } from '@mng-review/engine'
import {
	GitHubConfig,
	provideOwnedIdentities,
	StatusSweepService,
	toLogText,
} from '@mng-review/github'
import { Console, Effect } from 'effect'
import { getSettingsGate } from '../../application/risk-gate.helper'
import { riskRunConfig } from '../../infrastructure/risk-run.config'
import {
	outputPathConfig,
	writeOutputs,
} from '../../infrastructure/runner-output.client'
import {
	runnerEnvironmentConfig,
	writeSummary,
} from '../../infrastructure/runner.client'
import {
	ActionExit,
	FAILED_EXIT_CODE,
	INVALID_CONFIG_EXIT_CODE,
} from '../action-exit.errors'
import { formatSweepLine, formatSweepSummary } from '../summary.formatter'
import { listRiskPulls, SWEEP_RULES_REF } from './risk-sweep-step.handler'

/** The step output that hands the risk jobs their pull requests, as a JSON array of numbers. */
export const RISK_PULLS_OUTPUT = 'risk-pulls'
/** The most jobs GitHub builds from one matrix; `risk-pulls` feeds the risk jobs' matrix. */
export const RISK_MATRIX_LIMIT = 256

/** What the sweep did, and the pull requests the risk jobs check or why it could not list them. */
interface SweepOutcome {
	readonly line: string
	readonly pulls: readonly number[]
	readonly failure?: string
}

/**
 * Loads the rules from the default branch, so a pull request never decides which identities the
 * sweep owns, refreshes the statuses with the owned identities, and lists the pull requests the
 * risk jobs check. A failed status refresh is reported and passes, as before; a list the matrix
 * cannot hold whole is a failure, never split or cut.
 */
const sweepWithRules = Effect.gen(function* () {
	const rules = yield* RulesService.use(service =>
		service.load(SWEEP_RULES_REF)
	)
	const { identity } = yield* GitHubConfig
	const line = yield* StatusSweepService.use(service =>
		service.sweep(rules.config.commands.allow)
	).pipe(
		provideOwnedIdentities(identity, rules.config.identity.previous),
		Effect.map(formatSweepLine),
		Effect.catchTag('GitHubApiError', error =>
			Effect.succeed(`status sweep failed: ${error.message}`)
		)
	)
	return yield* listRiskPulls(rules).pipe(
		Effect.map((pulls): SweepOutcome =>
			pulls.length > RISK_MATRIX_LIMIT
				? {
						line,
						pulls: [],
						failure: `${pulls.length} open pull requests, more than the ${RISK_MATRIX_LIMIT} jobs a matrix can hold`,
					}
				: { line, pulls }
		),
		Effect.catchTag('GitHubApiError', error =>
			Effect.succeed<SweepOutcome>({ line, pulls: [], failure: error.message })
		)
	)
})

/** Writes the sweep's line to the log and the job summary. */
const finishSweep = Effect.fn('sweepStep.finish')(function* (line: string) {
	const env = yield* runnerEnvironmentConfig
	yield* Console.log(toLogText(`mng-review: ${line}`))
	yield* writeSummary(env.summaryPath, formatSweepSummary(line))
})

/**
 * The status sweep step. A GitHub or git error in the status refresh is reported and the step
 * passes, as before; a `ConfigError` is left to `failSweepConfig`. With the rating on, it hands the
 * open pull requests to the risk jobs through `risk-pulls`; when it cannot list them it fails with
 * exit 1, so a pass that checked nothing is never taken for one that found nothing. Rules that do
 * not load fail it the same way when the app settings would rate (`getSettingsGate`), since the
 * rules might have turned the rating on.
 */
export const runSweepStep = Effect.gen(function* () {
	const outcome = yield* sweepWithRules.pipe(
		Effect.catchTag('GitError', error =>
			Effect.gen(function* () {
				const line = `status sweep failed: git: ${error.message}`
				const settings = yield* riskRunConfig
				const { identity } = yield* GitHubConfig
				const gate = getSettingsGate({
					identity,
					settings,
					pr: { target: settings.defaultBranch },
				})
				// The rules may turn the rating on, so an empty list would skip every thread raise.
				return gate.status === 'on'
					? ({
							line,
							pulls: [],
							failure: 'the default branch rules did not load',
						} satisfies SweepOutcome)
					: ({ line, pulls: [] } satisfies SweepOutcome)
			})
		)
	)
	if (outcome.failure !== undefined) {
		yield* finishSweep(`${outcome.line}; risk pass failed: ${outcome.failure}`)
		return yield* new ActionExit({ code: FAILED_EXIT_CODE })
	}
	yield* writeOutputs(yield* outputPathConfig, {
		[RISK_PULLS_OUTPUT]: JSON.stringify(outcome.pulls),
	})
	return yield* finishSweep(outcome.line)
})

/** A domain `ConfigError` (a token or app setting, the rules) or one of Effect's own config errors. */
interface ConfigFailure {
	readonly message: string
}

/**
 * A broken token or app setting, or invalid rules on the default branch: reported, and the step
 * ends with exit 2 before any write.
 */
export const failSweepConfig = Effect.fn('sweepStep.failConfig')(function* (
	error: ConfigFailure
) {
	yield* finishSweep(`status sweep failed: ${error.message}`)
	return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
})
