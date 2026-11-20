import { ConfigError } from '@mng-review/domain'
import {
	getCommandHandle,
	GitHubConfig,
	provideOwnedIdentities,
	SummaryCommentService,
} from '@mng-review/github'
import { Console, Effect } from 'effect'
import type { ReserveDecision } from '../../application/command-run.types'
import { PrepareRunService } from '../../application/prepare-run.service'
import {
	type CommandTarget,
	commandHandlesConfig,
	commandTargetConfig,
	HANDLE_VARIABLE,
} from '../../infrastructure/command-run.config'
import {
	outputPathConfig,
	writeOutputs,
} from '../../infrastructure/runner-output.client'
import {
	runnerEnvironmentConfig,
	writeSummary,
} from '../../infrastructure/runner.client'
import { ActionExit, INVALID_CONFIG_EXIT_CODE } from '../action-exit.errors'
import {
	formatReserveLogLine,
	formatReserveSummary,
} from '../command.formatter'
import { readCommandEvent } from './command-event.handler'

/** What the reservation needs besides the target: the handle and the engine commit. */
interface ReserveContext {
	readonly handle: string
	readonly engineCommit: string | undefined
}

/** A run that is not reserved, with its reason. */
function refuse(reason: string): ReserveDecision {
	return { reserved: false, reason }
}

/**
 * The checks of a run once more, at the base commit's rules and the pull request read again, then
 * the count: a closed, moved, fork or draft pull request, a skip rule, an undeclared agent or the
 * cap reserves nothing.
 */
const reserve = Effect.fn('reserveStep.reserve')(function* (
	target: CommandTarget,
	context: ReserveContext
) {
	const read = yield* readCommandEvent(target)
	if (read.status === 'skipped') return refuse(read.reason)
	const prepared = yield* PrepareRunService.use(service =>
		service.prepare({
			eventName: 'issue_comment',
			readEvent: Effect.succeed(''),
			event: read.event,
		})
	)
	if (prepared.status !== 'ready')
		return refuse(`the run ended ${prepared.status}: ${prepared.reason}`)
	const { rules } = prepared
	if (!rules) return refuse('the rules were not loaded')
	if (
		target.agent !== undefined &&
		!rules.agents.some(agent => agent.name === target.agent)
	)
		return refuse(`no declared agent is named ${target.agent}`)
	const { identity } = yield* GitHubConfig
	const { max_runs: maxRuns } = rules.config.commands
	const reserved = yield* SummaryCommentService.use(service =>
		service.reserveManualRun({
			pullNumber: target.pullNumber,
			head: target.head,
			engineCommit: context.engineCommit,
			maxRuns,
			handle: context.handle,
		})
	).pipe(provideOwnedIdentities(identity, rules.config.identity.previous))
	return reserved
		? ({ reserved: true } satisfies ReserveDecision)
		: refuse(`commands.max_runs reached (${maxRuns})`)
})

/**
 * The reserve job's step: counts a manual run in the summary before the review job may start, over
 * the write token or the app token whose slug the config checked before any request. A refusal or a
 * GitHub error writes `reserved=false` and the step passes; a handle or identity error exits 2.
 */
export const runReserveStep = Effect.gen(function* () {
	const env = yield* runnerEnvironmentConfig
	const chosen = getCommandHandle(yield* commandHandlesConfig)
	if (chosen.status === 'denied')
		return yield* new ConfigError({
			source: HANDLE_VARIABLE,
			reason: chosen.reason,
		})
	const target = yield* commandTargetConfig
	const decision = yield* reserve(target, {
		handle: chosen.handle,
		engineCommit: env.engineCommit,
	}).pipe(
		Effect.catchTag('GitHubApiError', error =>
			Effect.succeed(refuse(`GitHub refused the count: ${error.message}`))
		)
	)
	yield* writeOutputs(yield* outputPathConfig, {
		reserved: String(decision.reserved),
	})
	yield* Console.log(formatReserveLogLine(decision))
	return yield* writeSummary(env.summaryPath, formatReserveSummary(decision))
})

/** A domain `ConfigError` or one of Effect's own config errors. */
interface ConfigFailure {
	readonly message: string
}

/** A handle, token or app setting that breaks the rules: nothing is counted, and the step exits 2. */
export const failReserveConfig = Effect.fn('reserveStep.failConfig')(function* (
	error: ConfigFailure
) {
	const env = yield* runnerEnvironmentConfig
	yield* writeOutputs(yield* outputPathConfig, { reserved: 'false' })
	yield* Console.log(formatReserveLogLine(refuse(error.message)))
	yield* writeSummary(
		env.summaryPath,
		formatReserveSummary(refuse(error.message))
	)
	return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
})
