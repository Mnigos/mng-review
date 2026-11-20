import { Console, Effect } from 'effect'
import {
	getBindingMismatch,
	toMismatchReason,
	toOutcomeBinding,
} from '../../application/outcome-file.helper'
import {
	PublishRunService,
	type PublishReport,
} from '../../application/publish-run.service'
import { OutcomeFileError } from '../../infrastructure/outcome-file.errors'
import { parseOutcomeFile } from '../../infrastructure/outcome-file.parser'
import { parsePullRequestEvent } from '../../infrastructure/pull-request-event.parser'
import { addPublishToResult } from '../../infrastructure/runner-output.client'
import {
	readEventText,
	readOutcomeText,
	type RunnerEnvironment,
	runnerEnvironmentConfig,
	writeSummary,
} from '../../infrastructure/runner.client'
import {
	ActionExit,
	FAILED_EXIT_CODE,
	INVALID_CONFIG_EXIT_CODE,
} from '../action-exit.errors'
import {
	formatPublishLogLine,
	formatPublishSummary,
} from '../summary.formatter'

/**
 * The downloaded outcome file, parsed and checked against what this job trusts: the repository,
 * run, attempt and engine commit from the runner, and the pull request and both commits from the
 * event payload, parsed again. The file's binding is never trusted on its own.
 */
const readTrustedOutcome = Effect.fn('publishStep.readTrustedOutcome')(
	function* (env: RunnerEnvironment) {
		const file = yield* parseOutcomeFile(
			yield* readOutcomeText(env.outcomePath)
		)
		const event = yield* readEventText(env.eventPath).pipe(
			Effect.flatMap(parsePullRequestEvent),
			Effect.mapError(
				error =>
					new OutcomeFileError({
						message: `the event cannot be read again: ${error.source} ${error.reason}`,
					})
			)
		)
		const trusted = toOutcomeBinding(event, env)
		const mismatch = getBindingMismatch(file.binding, trusted)
		if (mismatch !== undefined)
			return yield* new OutcomeFileError({
				message: toMismatchReason(mismatch),
			})
		return {
			file,
			context: {
				engineCommit: env.engineCommit,
				pullNumber: trusted.pullNumber,
				head: trusted.headSha,
				event,
			},
		}
	}
)

/** Writes the log line, the job summary and `publish` in the downloaded result file. */
const finishPublish = Effect.fn('publishStep.finish')(function* (
	report: PublishReport,
	env: RunnerEnvironment
) {
	yield* Console.log(formatPublishLogLine(report))
	yield* writeSummary(
		env.summaryPath,
		formatPublishSummary(report, env.engineCommit)
	)
	yield* addPublishToResult(env.resultPath, report)
})

/**
 * The publish job's step: posts the outcome file the review job uploaded and calls no model. A
 * missing file, one over the cap, one that does not parse or one bound to another run, attempt,
 * engine or pull request posts nothing and exits 1. Once the file is trusted, a GitHub refusal is
 * reported and the step passes, as before the split.
 */
export const runPublishStep = Effect.gen(function* () {
	const env = yield* runnerEnvironmentConfig
	const trusted = yield* readTrustedOutcome(env).pipe(
		Effect.map(value => ({ ok: true, ...value }) as const),
		Effect.catchTag('OutcomeFileError', error =>
			Effect.succeed({ ok: false, reason: error.message } as const)
		)
	)
	if (!trusted.ok) {
		yield* finishPublish({ status: 'failed', reason: trusted.reason }, env)
		return yield* new ActionExit({ code: FAILED_EXIT_CODE })
	}
	const report = yield* PublishRunService.use(service =>
		service.run(trusted.file, trusted.context)
	)
	return yield* finishPublish(report, env)
})

/** A domain `ConfigError` (a token or app setting, the rules) or one of Effect's own config errors. */
interface ConfigFailure {
	readonly message: string
}

/**
 * A token or app setting that breaks the rules of `GitHubWriteConfigLive`: nothing is posted, and
 * the step ends with exit 2 before any request.
 */
export const failPublishConfig = Effect.fn('publishStep.failConfig')(function* (
	error: ConfigFailure
) {
	const env = yield* runnerEnvironmentConfig
	yield* finishPublish({ status: 'failed', reason: error.message }, env)
	return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
})
