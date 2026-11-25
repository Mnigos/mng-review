import { RulesService } from '@mng-review/engine'
import {
	GitHubConfig,
	type RaiseResult,
	provideListCompleteness,
	provideOwnedIdentities,
	RaiseService,
	toLogText,
} from '@mng-review/github'
import { Console, Effect } from 'effect'
import { raiseTargetConfig } from '../../infrastructure/command-run.config'
import {
	runnerEnvironmentConfig,
	writeSummary,
} from '../../infrastructure/runner.client'
import {
	ActionExit,
	FAILED_EXIT_CODE,
	INVALID_CONFIG_EXIT_CODE,
} from '../action-exit.errors'
import { formatRaiseSummary } from '../summary.formatter'

/** The rules the raise reads the owned identities from: `HEAD` of the default branch checkout. */
const RAISE_RULES_REF = 'HEAD'

/** What the raise did on pull request `pullNumber`, in words. */
function toRaiseLine(pullNumber: number, result: RaiseResult): string {
	const at = `raise on #${pullNumber}`
	const nothing = 'so nothing was raised'
	if (result.outcome === 'closed') return `${at}: the pull request is closed`
	if (result.outcome === 'incomplete')
		return `${at}: a list GitHub returned was incomplete, ${nothing}`
	if (result.outcome === 'not-due')
		return `${at}: nothing to raise; something still blocks or nothing is left to raise`
	if (result.outcome === 'moved')
		return `${at}: the head moved before the writes, ${nothing}`
	if (result.outcome === 'changed')
		return `${at}: the status changed since the judgment, ${nothing}`
	const status =
		result.statusError === undefined
			? result.status
				? `${result.status.state} written`
				: 'status unchanged'
			: `status write refused (${result.statusError})`
	// A head that moved before the dismissal says so even when the status write was all that landed.
	if (result.movedBeforeDismissal)
		return `${at}: ${status}, the head moved before the dismissal, so the change requests stay`
	if (result.closedBeforeDismissal)
		return `${at}: ${status}, the pull request closed before the dismissal, so the change requests stay`
	// A refused dismissal is reported beside a blocking status write, which alone is `updated`.
	if (result.outcome === 'updated' && result.dismissal.failed === 0)
		return `${at}: ${status}, nothing to raise`
	return `${at}: ${status}, ${result.dismissal.dismissed} change request(s) dismissed, ${result.dismissal.failed} not dismissed`
}

/** Writes the raise's line to the log and the job summary. */
const finishRaise = Effect.fn('raiseStep.finish')(function* (line: string) {
	const env = yield* runnerEnvironmentConfig
	yield* Console.log(toLogText(`mng-review: ${line}`))
	yield* writeSummary(env.summaryPath, formatRaiseSummary(line))
})

/** Reports a raise that could not judge its pull request and ends the step with exit 1. */
const failRaise = Effect.fn('raiseStep.fail')(function* (line: string) {
	yield* finishRaise(`raise failed: ${line}`)
	return yield* new ActionExit({ code: FAILED_EXIT_CODE })
})

/**
 * The reply schedule's raise job, one pull request the find job listed, inside that pull request's
 * publish group: judges it again with the owned identities and `commands.allow` of the default
 * branch, and writes the bot's `success` and dismisses the current identity's change requests only
 * while nothing blocks (`RaiseService.raise`). It calls no model. A read GitHub refuses, or rules
 * that do not load, fail the step with exit 1; a status write GitHub refuses is reported beside the
 * dismissal, which still ran when due, and fails the step too; a dismissal GitHub refuses is
 * reported and passes, for the next schedule run that actually happens to try again. A
 * `ConfigError` is left to `failRaiseConfig`.
 */
export const runRaiseStep = Effect.gen(function* () {
	const rules = yield* RulesService.use(service =>
		service.load(RAISE_RULES_REF)
	)
	const { identity } = yield* GitHubConfig
	const pullNumber = yield* raiseTargetConfig
	const result = yield* RaiseService.use(service =>
		service.raise(pullNumber, rules.config.commands.allow)
	).pipe(
		provideOwnedIdentities(identity, rules.config.identity.previous),
		provideListCompleteness(rules.config.risk.enabled),
		Effect.catchTag('GitHubApiError', error => failRaise(error.message))
	)
	yield* finishRaise(toRaiseLine(pullNumber, result))
	// A refused status write is reported beside the dismissal and fails the step, as a read does.
	if (result.statusError === undefined) return yield* Effect.void
	return yield* new ActionExit({ code: FAILED_EXIT_CODE })
}).pipe(
	Effect.catchTag('GitError', error => failRaise(`git: ${error.message}`))
)

/** A domain `ConfigError` (a token or app setting, the rules) or one of Effect's own config errors. */
interface ConfigFailure {
	readonly message: string
}

/**
 * A broken token or app setting, target or rules on the default branch: reported, and the step
 * ends with exit 2 before any write.
 */
export const failRaiseConfig = Effect.fn('raiseStep.failConfig')(function* (
	error: ConfigFailure
) {
	yield* finishRaise(`raise failed: ${error.message}`)
	return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
})
