import { GitHubApiService } from '@mng-review/github'
import { Console, Effect } from 'effect'
import {
	getCommandStateMismatch,
	getConverseMismatch,
	toCommandEvent,
} from '../../application/command-event.helper'
import {
	getBindingMismatch,
	toMismatchReason,
	toOutcomeBinding,
} from '../../application/outcome-file.helper'
import { failsRating } from '../../application/publish-report.helper'
import {
	type PublishContext,
	PublishRunService,
	type PublishReport,
} from '../../application/publish-run.service'
import type { PullRequestEvent } from '../../application/shadow-run.types'
import {
	commandTargetConfig,
	type RunTrigger,
	triggerConfig,
} from '../../infrastructure/command-run.config'
import { OutcomeFileError } from '../../infrastructure/outcome-file.errors'
import { parseOutcomeFile } from '../../infrastructure/outcome-file.parser'
import { parsePullRequestEvent } from '../../infrastructure/pull-request-event.parser'
import { riskRunConfig } from '../../infrastructure/risk-run.config'
import { addPublishToResult } from '../../infrastructure/runner-output.client'
import {
	hasOutcomeFile,
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
 * The pull request a push run publishes, from the event payload parsed again; a payload that is
 * not a pull request event refuses the file.
 */
const readPushEvent = Effect.fn('publishStep.readPushEvent')(function* (
	env: RunnerEnvironment
) {
	return yield* readEventText(env.eventPath).pipe(
		Effect.flatMap(parsePullRequestEvent),
		Effect.mapError(
			error =>
				new OutcomeFileError({
					message: `the event cannot be read again: ${error.source} ${error.reason}`,
				})
		)
	)
})

/**
 * The pull request a command or reply schedule run publishes: the number and both commits from the
 * authorize or find job's outputs, what the gates read from the API. A target or a pull request
 * that cannot be read, or a command's that closed or became a fork while the review ran, refuses
 * the file; a moved head is published as a partial command run. For the schedule, a pull request
 * that closed, became a draft or a fork, or moved to another head or base is `skipped`: nothing
 * is posted and the next tick reads it again.
 */
const readCommandTarget = Effect.fn('publishStep.readCommandTarget')(
	function* (trigger: RunTrigger) {
		const target = yield* commandTargetConfig
		const pr = yield* GitHubApiService.use(api =>
			api.getPullRequest(target.pullNumber)
		)
		const event = toCommandEvent(pr, target)
		if (trigger === 'converse') {
			const skipped = getConverseMismatch(pr, target)
			return { event, converse: true, ...(skipped ? { skipped } : {}) }
		}
		const mismatch = getCommandStateMismatch(pr)
		if (mismatch !== undefined)
			return yield* new OutcomeFileError({ message: mismatch })
		return { event, command: { agentOnly: target.agent !== undefined } }
	},
	Effect.catchTags({
		ConfigError: error =>
			Effect.fail(
				new OutcomeFileError({
					message: `the command's target cannot be read: ${error.message}`,
				})
			),
		GitHubApiError: error =>
			Effect.fail(
				new OutcomeFileError({
					message: `the pull request cannot be read again: ${error.message}`,
				})
			),
	})
)

/** The pull request a publish job trusts, and what started its run. */
interface TrustedTarget extends Pick<PublishContext, 'command' | 'converse'> {
	readonly event: PullRequestEvent
	/** Why a reply schedule run posts nothing on a pull request that changed since it was listed. */
	readonly skipped?: string
}

/**
 * The downloaded outcome file, parsed and checked against what this job trusts: the repository,
 * run, attempt and engine commit from the runner, the trigger, and the pull request and both
 * commits from the event payload parsed again, or for a command from the authorize job's outputs.
 * The file's binding is never trusted on its own, and is checked before a reply schedule run's
 * `skipped`, so a forged file still fails.
 */
const readTrustedOutcome = Effect.fn('publishStep.readTrustedOutcome')(
	function* (env: RunnerEnvironment) {
		const file = yield* parseOutcomeFile(
			yield* readOutcomeText(env.outcomePath)
		)
		const trigger = yield* triggerConfig.pipe(
			Effect.mapError(error => new OutcomeFileError({ message: error.message }))
		)
		const read: TrustedTarget =
			trigger === 'push'
				? { event: yield* readPushEvent(env) }
				: yield* readCommandTarget(trigger)
		const { event, command, converse } = read
		const trusted = toOutcomeBinding(event, { ...env, trigger })
		const mismatch = getBindingMismatch(file.binding, trusted)
		if (mismatch !== undefined)
			return yield* new OutcomeFileError({
				message: toMismatchReason(mismatch),
			})
		if (read.skipped !== undefined) return { skipped: read.skipped }
		const risk = yield* riskRunConfig.pipe(
			Effect.orElseSucceed(() => ({ environment: '', defaultBranch: '' }))
		)
		return {
			file,
			context: {
				risk,
				engineCommit: env.engineCommit,
				pullNumber: trusted.pullNumber,
				head: trusted.headSha,
				event,
				...(command ? { command } : {}),
				...(converse ? { converse } : {}),
			},
		}
	}
)

const NO_OUTCOME_REASON =
	'no outcome file; the review leg had no answer to publish'

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
 * Reports a reply schedule run whose review leg uploaded no outcome as not published, and says
 * whether it did. It needs no repository checkout and no GitHub service, so the entry runs it
 * before building the publish layers, whose git service needs the checkout the workflow skips then.
 */
export const publishMissingOutcome = Effect.gen(function* () {
	const env = yield* runnerEnvironmentConfig
	const trigger = yield* triggerConfig.pipe(
		Effect.orElseSucceed(() => 'push' as const)
	)
	if (trigger !== 'converse' || (yield* hasOutcomeFile(env.outcomePath)))
		return false
	yield* finishPublish(
		{ status: 'not-published', reason: NO_OUTCOME_REASON },
		env
	)
	return true
})

/**
 * The publish job's step: posts the outcome file the review job uploaded and calls no model. A
 * missing file, one over the cap, one that does not parse or one bound to another run, attempt,
 * engine or pull request posts nothing and exits 1; for the reply schedule a missing file means
 * the review leg had nothing to answer, and a pull request that changed since the find job listed
 * it is left to the next tick: both post nothing and the step passes. Once the file is trusted, a
 * GitHub refusal is reported and the step passes, as before the split, unless the run rates: then
 * any failed report carries a failed rating, and the step exits 1 on it or on a grant that may
 * still stand.
 */
export const runPublishStep = Effect.gen(function* () {
	if (yield* publishMissingOutcome) return yield* Effect.void
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
	if (trusted.skipped !== undefined)
		return yield* finishPublish(
			{ status: 'not-published', reason: trusted.skipped },
			env
		)
	const report = yield* PublishRunService.use(service =>
		service.run(trusted.file, trusted.context)
	)
	yield* finishPublish(report, env)
	// A failed rating fails the job, so the merge sweep's run hold sees it and the cleanup runs.
	if (!failsRating(report)) return yield* Effect.void
	return yield* new ActionExit({ code: FAILED_EXIT_CODE })
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
