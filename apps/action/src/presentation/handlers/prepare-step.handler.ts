import { PublishService, toLogText } from '@mng-review/github'
import { Console, Effect, FileSystem } from 'effect'
import { PrepareRunService } from '../../application/prepare-run.service'
import type {
	PreparedRun,
	PriorRun,
	PullRequestEvent,
} from '../../application/shadow-run.types'
import {
	outputPathConfig,
	writeOutputs,
} from '../../infrastructure/runner-output.client'
import {
	readEventText,
	runnerEnvironmentConfig,
	writePrepared,
} from '../../infrastructure/runner.client'

/** The prepare step's log line: the prepared status and, unless it is ready, why. */
function toPrepareLine(prepared: PreparedRun): string {
	const reason = prepared.status === 'ready' ? '' : `: ${prepared.reason}`
	return toLogText(`mng-review: prepare ${prepared.status}${reason}`)
}

/**
 * The prepare step of the review job: the checks before the probe and the GitHub reads over the
 * read token, with no endpoint variable and no model. A GitHub error counts as no prior run and
 * no threads. It writes the prepared file and the step output `ready`, and never fails on an
 * outcome; the review step reports it.
 */
export const runPrepareStep = Effect.gen(function* () {
	const env = yield* runnerEnvironmentConfig
	const fs = yield* FileSystem.FileSystem
	const publisher = yield* PublishService
	const readPrior = (event: PullRequestEvent) =>
		publisher.readPrior(event.number).pipe(
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
	const readThreads = (event: PullRequestEvent) =>
		publisher.readThreads(event.number).pipe(Effect.orElseSucceed(() => []))
	const prepared = yield* PrepareRunService.use(service =>
		service.prepare({
			eventName: env.eventName,
			readEvent: readEventText(env.eventPath).pipe(
				Effect.provideService(FileSystem.FileSystem, fs)
			),
			readPrior,
			readThreads,
		})
	)
	yield* writePrepared(env.preparedPath, prepared)
	yield* Console.log(toPrepareLine(prepared))
	yield* writeOutputs(yield* outputPathConfig, {
		ready: String(prepared.status === 'ready'),
	})
})
