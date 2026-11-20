import type { Rules } from '@mng-review/engine'
import {
	GitHubConfig,
	provideOwnedIdentities,
	PublishService,
	SummaryCommentService,
	toLogText,
} from '@mng-review/github'
import { Console, Effect, FileSystem } from 'effect'
import type { CommandEventRead } from '../../application/command-run.types'
import { PrepareRunService } from '../../application/prepare-run.service'
import type {
	PreparedRun,
	PriorRun,
	PullRequestEvent,
} from '../../application/shadow-run.types'
import {
	commandTargetConfig,
	triggerConfig,
} from '../../infrastructure/command-run.config'
import {
	outputPathConfig,
	writeOutputs,
} from '../../infrastructure/runner-output.client'
import {
	readEventText,
	runnerEnvironmentConfig,
	writePrepared,
} from '../../infrastructure/runner.client'
import { readCommandEvent } from './command-event.handler'

/** The prepare step's log line: the prepared status and, unless it is ready, why. */
function toPrepareLine(prepared: PreparedRun): string {
	const reason = prepared.status === 'ready' ? '' : `: ${prepared.reason}`
	return toLogText(`mng-review: prepare ${prepared.status}${reason}`)
}

/**
 * A command run's pull request, read again instead of the comment's event; a closed, moved or
 * fork pull request skips the run. `undefined` for a push run.
 */
const readCommandRun = Effect.gen(function* () {
	if ((yield* triggerConfig) !== 'command') return undefined
	return yield* readCommandEvent(yield* commandTargetConfig)
}).pipe(
	Effect.catchTag('ConfigError', error =>
		Effect.succeed({
			status: 'skipped',
			reason: `the command's target cannot be read: ${error.message}`,
		} satisfies CommandEventRead)
	)
)

/**
 * The prepare step of the review job: the checks before the probe and the GitHub reads over the
 * read token, with no endpoint variable and no model. The comments of every bot identity the base
 * rules own count. A GitHub error counts as no prior run and no threads. It writes the prepared file and the step output `ready`, and never fails on an
 * outcome; the review step reports it.
 */
export const runPrepareStep = Effect.gen(function* () {
	const env = yield* runnerEnvironmentConfig
	const fs = yield* FileSystem.FileSystem
	const publisher = yield* PublishService
	const summaries = yield* SummaryCommentService
	const { identity } = yield* GitHubConfig
	const readPrior = (event: PullRequestEvent, rules: Rules) =>
		summaries.readPrior(event.number).pipe(
			provideOwnedIdentities(identity, rules.config.identity.previous),
			Effect.map((marker): PriorRun | undefined =>
				marker
					? {
							runs: marker.runs,
							...(marker.head === undefined ? {} : { head: marker.head }),
						}
					: undefined
			),
			Effect.orElseSucceed(() => undefined)
		)
	const readThreads = (event: PullRequestEvent, rules: Rules) =>
		publisher.readThreads(event.number).pipe(
			provideOwnedIdentities(identity, rules.config.identity.previous),
			Effect.orElseSucceed(() => [])
		)
	const command = yield* readCommandRun
	const prepared: PreparedRun =
		command?.status === 'skipped'
			? command
			: yield* PrepareRunService.use(service =>
					service.prepare({
						eventName: env.eventName,
						readEvent: readEventText(env.eventPath).pipe(
							Effect.provideService(FileSystem.FileSystem, fs)
						),
						readPrior,
						readThreads,
						...(command ? { event: command.event } : {}),
					})
				)
	yield* writePrepared(env.preparedPath, prepared)
	yield* Console.log(toPrepareLine(prepared))
	yield* writeOutputs(yield* outputPathConfig, {
		ready: String(prepared.status === 'ready'),
	})
})
