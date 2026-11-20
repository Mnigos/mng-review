import {
	getPublishedFindings,
	ReplyDecisionService,
	type ReplyDecisions,
	ThreadRecheckService,
	type ThreadRecheckProposals,
} from '@mng-review/github'
import { Clock, Console, Effect, FileSystem } from 'effect'
import {
	getBindingMismatch,
	isPublishable,
	toMismatchReason,
	toOutcomeBinding,
	toOutcomeFile,
	toOutcomeText,
} from '../../application/outcome-file.helper'
import { ShadowRunService } from '../../application/shadow-run.service'
import type {
	PreparedRun,
	ReviewedRun,
	ShadowOutcome,
} from '../../application/shadow-run.types'
import {
	commandTargetConfig,
	type RunTrigger,
	triggerConfig,
} from '../../infrastructure/command-run.config'
import { OutcomeFileError } from '../../infrastructure/outcome-file.errors'
import { parseOutcomeFile } from '../../infrastructure/outcome-file.parser'
import { parsePreparedRun } from '../../infrastructure/prepared-run.parser'
import {
	outputPathConfig,
	writeOutputs,
} from '../../infrastructure/runner-output.client'
import {
	maskEndpoint,
	readEventText,
	readPreparedText,
	type RunnerEnvironment,
	runnerEnvironmentConfig,
	writeOutcome,
	writeResult,
	writeSummary,
} from '../../infrastructure/runner.client'
import {
	ActionExit,
	FAILED_EXIT_CODE,
	INVALID_CONFIG_EXIT_CODE,
} from '../action-exit.errors'
import { formatResult } from '../result.formatter'
import {
	formatLogLine,
	formatPublishLogLine,
	formatSummary,
} from '../summary.formatter'

/** Which step reviewed: shadow mode, or the review step of publish mode's review job. */
type ReviewStep = 'shadow' | 'review'

/** What a review step knows when it reports: where it runs, when it started and what it masked. */
interface ReviewReportContext {
	readonly step: ReviewStep
	readonly env: RunnerEnvironment
	readonly startedAt: number
	readonly masked: readonly string[]
}

/** Writes the log line, the job summary and the result file, and exits by the outcome. */
const finishReview = Effect.fn('reviewStep.finish')(function* (
	outcome: ShadowOutcome,
	context: ReviewReportContext
) {
	const { env, step } = context
	const wallMillis = (yield* Clock.currentTimeMillis) - context.startedAt
	yield* Console.log(formatLogLine(outcome))
	yield* writeSummary(
		env.summaryPath,
		formatSummary(outcome, {
			engineCommit: env.engineCommit,
			...(step === 'review' ? { step } : {}),
		})
	)
	yield* writeResult(
		env.resultPath,
		formatResult(outcome, {
			...env,
			wallMillis,
			masked: context.masked,
			...(step === 'review' ? { mode: 'publish' as const } : {}),
		})
	)
})

/** Fails with the outcome's exit code: 2 for an invalid configuration, 1 for a failure. */
const exitByOutcome = Effect.fn('reviewStep.exit')(function* (
	outcome: ShadowOutcome
) {
	if (outcome.status === 'invalid-config')
		return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
	if (outcome.status === 'failed')
		return yield* new ActionExit({ code: FAILED_EXIT_CODE })
	return yield* Effect.void
})

/**
 * Shadow mode: the checks and the review in one process, the job summary and the result file.
 * Nothing reads or writes GitHub.
 */
export const runShadowStep = Effect.gen(function* () {
	const startedAt = yield* Clock.currentTimeMillis
	const masked = yield* maskEndpoint()
	const env = yield* runnerEnvironmentConfig
	const fs = yield* FileSystem.FileSystem
	const outcome = yield* ShadowRunService.use(service =>
		service.run({
			eventName: env.eventName,
			readEvent: readEventText(env.eventPath).pipe(
				Effect.provideService(FileSystem.FileSystem, fs)
			),
		})
	)
	yield* finishReview(outcome, { step: 'shadow', env, startedAt, masked })
	return yield* exitByOutcome(outcome)
})

/**
 * The validator over the bot's threads the prepare step read, for a reviewed run whose plan did
 * not skip it; `rotation` is the run count from the prior summary. It only proposes.
 */
const proposeRecheck = (outcome: ReviewedRun, prepared: PreparedRun) =>
	ThreadRecheckService.use(service =>
		service.propose({
			rotation: prepared.status === 'ready' ? (prepared.prior?.runs ?? 0) : 0,
			pr: outcome.event.pr,
			rules: outcome.rules,
			head: outcome.event.headSha,
			threads: prepared.status === 'ready' ? prepared.threads : [],
			published: getPublishedFindings({
				outcome: outcome.report,
				config: outcome.rules.config,
				agents: new Map(outcome.rules.agents.map(agent => [agent.name, agent])),
			}),
		})
	)

/**
 * The engine's decisions on the authors' replies the prepare step read, after the re-check and on
 * the same token ledger. Only reviewed runs get here, so a skipped or offline run decides nothing.
 */
const decideReplies = (outcome: ReviewedRun, prepared: PreparedRun) =>
	prepared.status === 'ready'
		? ReplyDecisionService.use(service =>
				service.decide({
					rules: outcome.rules,
					pr: outcome.event.pr,
					head: outcome.event.headSha,
					mergeBase: outcome.report.planReport.change.mergeBase,
					replies: prepared.replies ?? [],
					threads: prepared.threads,
				})
			)
		: Effect.succeed(undefined)

/**
 * Builds the outcome file's text, parses it back and checks its binding against this job's event
 * and runner before it writes it, so a file that would not parse or would be refused is never
 * written. The publish job parses it again and checks it against its own trusted binding.
 */
const writeCheckedOutcome = Effect.fn('reviewStep.writeCheckedOutcome')(
	function* (outcome: ShadowOutcome, report: OutcomeContext) {
		const { env, recheck, replies } = report
		const file = toOutcomeFile(outcome, recheck, env, replies)
		if (!file || !outcome.event) return undefined
		const text = toOutcomeText(file, report.masked)
		const parsed = yield* parseOutcomeFile(text)
		const mismatch = getBindingMismatch(
			parsed.binding,
			toOutcomeBinding(outcome.event, env)
		)
		if (mismatch !== undefined)
			return yield* new OutcomeFileError({
				message: toMismatchReason(mismatch),
			})
		return yield* writeOutcome(env.outcomePath, text)
	}
)

/** The runner's variables and what started the run. */
interface ReviewEnvironment extends RunnerEnvironment {
	readonly trigger: RunTrigger
}

/** What the outcome file is built from besides the outcome. */
interface OutcomeContext {
	readonly env: ReviewEnvironment
	readonly recheck: ThreadRecheckProposals | undefined
	readonly replies: ReplyDecisions | undefined
	readonly masked: readonly string[]
}

/**
 * The review step of publish mode's review job: every model call and nothing on GitHub. It reads
 * the prepared file, reviews, proposes the re-check over the prepared threads, decides on the
 * authors' replies the prepare step read, writes the checked
 * outcome file, the job summary, the result file and the step output `publish`. A prepared file
 * that cannot be read or decoded is an invalid configuration naming `MNG_REVIEW_PREPARED_PATH`. An
 * outcome to post whose file fails its own parse or binding check is not written, and the step
 * exits 1 with the reason in the log.
 */
export const runReviewStep = Effect.gen(function* () {
	const startedAt = yield* Clock.currentTimeMillis
	const masked = yield* maskEndpoint()
	const env = yield* runnerEnvironmentConfig
	const prepared = yield* readPreparedText(env.preparedPath).pipe(
		Effect.flatMap(parsePreparedRun),
		Effect.catchTag('ConfigError', error =>
			Effect.succeed({
				status: 'invalid-config',
				source: error.source,
				reason: error.reason,
			} satisfies PreparedRun)
		)
	)
	const trigger = yield* triggerConfig
	const onlyAgent =
		trigger === 'command' ? (yield* commandTargetConfig).agent : undefined
	const outcome = yield* ShadowRunService.use(service =>
		service.review(prepared, onlyAgent ? { onlyAgent } : {})
	)
	const reviewed =
		outcome.status === 'reviewed' && !outcome.report.planReport.plan.skippedRun
			? outcome
			: undefined
	const recheck = reviewed
		? yield* proposeRecheck(reviewed, prepared)
		: undefined
	const replies = reviewed
		? yield* decideReplies(reviewed, prepared)
		: undefined
	const refused = yield* writeCheckedOutcome(outcome, {
		env: { ...env, trigger },
		recheck,
		replies,
		masked,
	}).pipe(
		Effect.as(undefined),
		Effect.catchTag('OutcomeFileError', error => Effect.succeed(error.message))
	)
	yield* finishReview(outcome, { step: 'review', env, startedAt, masked })
	const publishable = isPublishable(outcome, trigger)
	const publish = refused === undefined && publishable
	yield* writeOutputs(yield* outputPathConfig, { publish: String(publish) })
	if (refused !== undefined && publishable) {
		yield* Console.log(
			formatPublishLogLine({ status: 'failed', reason: refused })
		)
		return yield* new ActionExit({ code: FAILED_EXIT_CODE })
	}
	return yield* exitByOutcome(outcome)
})
