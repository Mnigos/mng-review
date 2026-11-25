import { RulesService } from '@mng-review/engine'
import {
	GitHubConfig,
	type LiftResult,
	provideListCompleteness,
	provideOwnedIdentities,
	RequestLiftService,
	toLogText,
} from '@mng-review/github'
import { Console, Effect } from 'effect'
import { liftTargetConfig } from '../../infrastructure/command-run.config'
import {
	runnerEnvironmentConfig,
	writeSummary,
} from '../../infrastructure/runner.client'
import {
	ActionExit,
	FAILED_EXIT_CODE,
	INVALID_CONFIG_EXIT_CODE,
} from '../action-exit.errors'
import { formatLiftSummary } from '../summary.formatter'

/** The rules the lift reads the owned identities from: `HEAD` of the default branch checkout. */
const LIFT_RULES_REF = 'HEAD'

/** What the lift did on pull request `pullNumber`, in words. */
function toLiftLine(pullNumber: number, result: LiftResult): string {
	const at = `change request lift on #${pullNumber}`
	if (result.outcome === 'closed') return `${at}: the pull request is closed`
	if (result.outcome === 'incomplete')
		return `${at}: a list GitHub returned was incomplete, so nothing was dismissed`
	if (result.outcome === 'not-due')
		return `${at}: nothing to dismiss; a change request is still backed or none is left`
	if (result.outcome === 'moved')
		return `${at}: the head moved before the dismissal, so nothing was dismissed`
	return `${at}: ${result.dismissal.dismissed} change request(s) dismissed, ${result.dismissal.failed} not dismissed`
}

/** Writes the lift's line to the log and the job summary. */
const finishLift = Effect.fn('liftStep.finish')(function* (line: string) {
	const env = yield* runnerEnvironmentConfig
	yield* Console.log(toLogText(`mng-review: ${line}`))
	yield* writeSummary(env.summaryPath, formatLiftSummary(line))
})

/** Reports a lift that could not judge its pull request and ends the step with exit 1. */
const failLift = Effect.fn('liftStep.fail')(function* (line: string) {
	yield* finishLift(`change request lift failed: ${line}`)
	return yield* new ActionExit({ code: FAILED_EXIT_CODE })
})

/**
 * The reply schedule's lift job, one pull request the find job listed, inside that pull request's
 * publish group: judges it again with the owned identities and `commands.allow` of the default
 * branch, and dismisses the current identity's change requests only while nothing backs them
 * (`RequestLiftService.lift`). It calls no model and writes no status. A read GitHub refuses, or
 * rules that do not load, fail the step with exit 1; a dismissal GitHub refuses is reported and
 * passes, for the next tick to try again. A `ConfigError` is left to `failLiftConfig`.
 */
export const runLiftStep = Effect.gen(function* () {
	const rules = yield* RulesService.use(service => service.load(LIFT_RULES_REF))
	const { identity } = yield* GitHubConfig
	const pullNumber = yield* liftTargetConfig
	const result = yield* RequestLiftService.use(service =>
		service.lift(pullNumber, rules.config.commands.allow)
	).pipe(
		provideOwnedIdentities(identity, rules.config.identity.previous),
		provideListCompleteness(rules.config.risk.enabled),
		Effect.catchTag('GitHubApiError', error => failLift(error.message))
	)
	return yield* finishLift(toLiftLine(pullNumber, result))
}).pipe(Effect.catchTag('GitError', error => failLift(`git: ${error.message}`)))

/** A domain `ConfigError` (a token or app setting, the rules) or one of Effect's own config errors. */
interface ConfigFailure {
	readonly message: string
}

/**
 * A broken token or app setting, target or rules on the default branch: reported, and the step
 * ends with exit 2 before any write.
 */
export const failLiftConfig = Effect.fn('liftStep.failConfig')(function* (
	error: ConfigFailure
) {
	yield* finishLift(`change request lift failed: ${error.message}`)
	return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
})
