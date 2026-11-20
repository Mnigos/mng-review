import { RulesService } from '@mng-review/engine'
import {
	GitHubConfig,
	provideOwnedIdentities,
	StatusSweepService,
	toLogText,
} from '@mng-review/github'
import { Console, Effect } from 'effect'
import {
	runnerEnvironmentConfig,
	writeSummary,
} from '../../infrastructure/runner.client'
import { ActionExit, INVALID_CONFIG_EXIT_CODE } from '../action-exit.errors'
import { formatSweepLine, formatSweepSummary } from '../summary.formatter'

/** The rules the sweep reads `identity.previous` from: `HEAD` of the default branch checkout. */
const SWEEP_RULES_REF = 'HEAD'

/**
 * Loads the rules from the default branch, so a pull request never decides which identities the
 * sweep owns, then refreshes the statuses with the owned identities.
 */
const sweepWithRules = Effect.gen(function* () {
	const rules = yield* RulesService.use(service =>
		service.load(SWEEP_RULES_REF)
	)
	const { identity } = yield* GitHubConfig
	return yield* StatusSweepService.use(service => service.sweep()).pipe(
		provideOwnedIdentities(identity, rules.config.identity.previous)
	)
})

/** Writes the sweep's line to the log and the job summary. */
const finishSweep = Effect.fn('sweepStep.finish')(function* (line: string) {
	const env = yield* runnerEnvironmentConfig
	yield* Console.log(toLogText(`mng-review: ${line}`))
	yield* writeSummary(env.summaryPath, formatSweepSummary(line))
})

/**
 * The status sweep step. A GitHub or git error is reported and the step passes, as before; a
 * `ConfigError` is left to `failSweepConfig`.
 */
export const runSweepStep = Effect.gen(function* () {
	const line = yield* sweepWithRules.pipe(
		Effect.map(formatSweepLine),
		Effect.catchTags({
			GitHubApiError: error =>
				Effect.succeed(`status sweep failed: ${error.message}`),
			GitError: error =>
				Effect.succeed(`status sweep failed: git: ${error.message}`),
		})
	)
	yield* finishSweep(line)
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
