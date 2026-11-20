#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import {
	EndpointProbeServiceLive,
	GitServiceLive,
	GitWorkdir,
	RecheckServiceLive,
	ReviewRunServiceLive,
	RulesServiceLive,
	TokenLedgerLive,
} from '@mng-review/engine'
import {
	GitHubApiServiceLive,
	GitHubConfigLive,
	GitHubStatusServiceLive,
	getPublishedFindings,
	PublishService,
	PublishServiceLive,
	StatusReportServiceLive,
	StatusSweepService,
	StatusSweepServiceLive,
	ThreadRecheckService,
	ThreadRecheckServiceLive,
	ThreadResolutionServiceLive,
	toLogText,
} from '@mng-review/github'
import { Clock, Console, Effect, FileSystem, Layer, Ref } from 'effect'
import { FetchHttpClient } from 'effect/http'
import {
	getBindingMismatch,
	toOutcomeBinding,
	toOutcomeFile,
	toOutcomeText,
} from './application/outcome-file.helper'
import {
	PublishRunService,
	PublishRunServiceLive,
	type PublishContext,
	type PublishReport,
} from './application/publish-run.service'
import {
	ShadowRunService,
	ShadowRunServiceLive,
} from './application/shadow-run.service'
import type {
	PullRequestEvent,
	ReviewedRun,
	ShadowOutcome,
} from './application/shadow-run.types'
import { parseOutcomeFile } from './infrastructure/outcome-file.parser'
import type { OutcomeFile } from './infrastructure/outcome-file.schema'
import {
	MODE_VARIABLE,
	maskEndpoint,
	modeConfig,
	readEventText,
	repoDirConfig,
	type RunnerEnvironment,
	runnerEnvironmentConfig,
	writeOutcome,
	writeResult,
	writeSummary,
} from './infrastructure/runner.client'
import {
	ActionExit,
	FAILED_EXIT_CODE,
	INVALID_CONFIG_EXIT_CODE,
} from './presentation/action-exit.errors'
import { formatResult } from './presentation/result.formatter'
import {
	formatLogLine,
	formatPublishLogLine,
	formatSummary,
	formatSweepLine,
	formatSweepSummary,
} from './presentation/summary.formatter'

/** Bun's process and file system, `fetch` for the endpoint, and git in the caller's checkout. */
const PlatformLive = Layer.mergeAll(
	BunServices.layer,
	FetchHttpClient.layer,
	Layer.effect(
		GitWorkdir,
		Effect.gen(function* () {
			return { cwd: yield* repoDirConfig }
		})
	)
)

/** The rules, the review run and the probe over one git service and one token ledger. */
const SessionLive = Layer.mergeAll(
	ReviewRunServiceLive,
	EndpointProbeServiceLive
).pipe(
	Layer.provideMerge(RulesServiceLive),
	Layer.provideMerge(GitServiceLive),
	Layer.provideMerge(TokenLedgerLive)
)

/** The shadow run over the session, which stays available for publishing. */
const ActionLive = ShadowRunServiceLive.pipe(Layer.provideMerge(SessionLive))

/** The GitHub API and status calls over the job token; built only in publish and sweep mode. */
const GitHubLive = Layer.mergeAll(
	GitHubApiServiceLive,
	GitHubStatusServiceLive
).pipe(Layer.provideMerge(GitHubConfigLive))

/** Publishing, thread resolution and the status over the job token. */
const PublisherLive = Layer.mergeAll(
	PublishServiceLive,
	StatusReportServiceLive
).pipe(
	Layer.provide(ThreadResolutionServiceLive),
	Layer.provideMerge(GitHubLive)
)

/** The publish run on top of the publisher; it calls no model. */
const PublishLive = PublishRunServiceLive.pipe(
	Layer.provideMerge(PublisherLive)
)

/** The re-check of the bot's threads over the model, and the publisher to read them. */
const RecheckLive = Layer.mergeAll(
	ThreadRecheckServiceLive.pipe(Layer.provide(RecheckServiceLive)),
	PublisherLive
)

/** Refreshes the status of open pull requests; a missing token or a GitHub error is reported. */
const runSweep = Effect.gen(function* () {
	const env = yield* runnerEnvironmentConfig
	const line = yield* StatusSweepService.use(service => service.sweep()).pipe(
		Effect.map(formatSweepLine),
		Effect.provide(StatusSweepServiceLive.pipe(Layer.provide(GitHubLive))),
		Effect.catchTags({
			ConfigError: error =>
				Effect.succeed(`status sweep failed: ${error.message}`),
			GitHubApiError: error =>
				Effect.succeed(`status sweep failed: ${error.message}`),
		})
	)
	yield* Console.log(toLogText(`mng-review: ${line}`))
	yield* writeSummary(env.summaryPath, formatSweepSummary(line))
})

/**
 * The earlier runs on the pull request from the sticky summary; a missing token or a GitHub error
 * counts as none, so the review still runs.
 */
const readPrior = (event: PullRequestEvent) =>
	PublishService.use(service => service.readPrior(event.number)).pipe(
		Effect.provide(PublisherLive),
		Effect.orElseSucceed(() => undefined)
	)

/**
 * Reads the bot's threads and checks the changed ones again with the validator; `rotation` is the
 * run count from the prior summary. A missing token or a GitHub error means no proposals.
 */
const proposeRecheck = (outcome: ReviewedRun, rotation: number) =>
	Effect.gen(function* () {
		const { event, report, rules } = outcome
		const threads = yield* PublishService.use(service =>
			service.readThreads(event.number)
		)
		return yield* ThreadRecheckService.use(service =>
			service.propose({
				rotation,
				pr: event.pr,
				rules,
				head: event.headSha,
				threads,
				published: getPublishedFindings({
					outcome: report,
					config: rules.config,
					agents: new Map(rules.agents.map(agent => [agent.name, agent])),
				}),
			})
		)
	}).pipe(
		Effect.provide(RecheckLive),
		Effect.orElseSucceed(() => undefined)
	)

/** Publishes a parsed outcome file; a missing token or repository is reported, never fatal. */
const publishParsed = (outcome: OutcomeFile, context: PublishContext) =>
	PublishRunService.use(service => service.run(outcome, context)).pipe(
		Effect.provide(PublishLive),
		Effect.catchTag('ConfigError', error =>
			Effect.succeed({
				status: 'failed',
				reason: error.message,
			} satisfies PublishReport)
		)
	)

/**
 * Publish mode after the review: the re-check proposes, the outcome becomes the outcome file,
 * written when `MNG_REVIEW_OUTCOME_PATH` is set and parsed back, its binding is checked against
 * the runner and the event, and publishing works from the parsed file alone. A file that fails
 * to write, parse or match publishes nothing and the report says why.
 */
const publishOutcome = (
	outcome: ShadowOutcome,
	rotation: number,
	env: RunnerEnvironment,
	masked: readonly string[]
) =>
	Effect.gen(function* () {
		const recheck =
			outcome.status === 'reviewed' &&
			!outcome.report.planReport.plan.skippedRun
				? yield* proposeRecheck(outcome, rotation)
				: undefined
		const file = toOutcomeFile(outcome, recheck, env)
		if (!file || !outcome.event)
			return {
				status: 'not-published',
				reason: `the run ended ${outcome.status}`,
			} satisfies PublishReport
		const trusted = toOutcomeBinding(outcome.event, env)
		const text = toOutcomeText(file, masked)
		const parsed = yield* parseOutcomeFile(text)
		const mismatch = getBindingMismatch(parsed.binding, trusted)
		if (mismatch !== undefined)
			return {
				status: 'failed',
				reason: `the outcome file belongs to another run: ${mismatch} differs`,
			} satisfies PublishReport
		yield* writeOutcome(env.outcomePath, text)
		return yield* publishParsed(parsed, {
			engineCommit: env.engineCommit,
			pullNumber: trusted.pullNumber,
			head: trusted.headSha,
		})
	}).pipe(
		Effect.catchTags({
			OutcomeFileError: error =>
				Effect.succeed({
					status: 'failed',
					reason: error.message,
				} satisfies PublishReport),
			PlatformError: error =>
				Effect.succeed({
					status: 'failed',
					reason: `the outcome file cannot be written: ${error.message}`,
				} satisfies PublishReport),
		})
	)

/**
 * Reviews the pull request of the workflow's event, writes the job summary and the result file,
 * and exits by the outcome.
 */
const runAction = Effect.gen(function* () {
	const startedAt = yield* Clock.currentTimeMillis
	const masked = yield* maskEndpoint()
	const env = yield* runnerEnvironmentConfig
	const mode = yield* modeConfig.pipe(Effect.option)
	if (mode._tag === 'None') {
		const invalid: ShadowOutcome = {
			status: 'invalid-config',
			source: MODE_VARIABLE,
			reason: 'must be shadow, publish or sweep',
		}
		yield* Console.log(formatLogLine(invalid))
		yield* writeSummary(
			env.summaryPath,
			formatSummary(invalid, { engineCommit: env.engineCommit })
		)
		yield* writeResult(
			env.resultPath,
			formatResult(invalid, {
				...env,
				wallMillis: (yield* Clock.currentTimeMillis) - startedAt,
				masked,
			})
		)
		return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
	}
	if (mode.value === 'sweep') return yield* runSweep
	const fs = yield* FileSystem.FileSystem
	const priorServices =
		yield* Effect.context<Effect.Services<ReturnType<typeof readPrior>>>()
	const priorRuns = yield* Ref.make(0)
	const outcome = yield* ShadowRunService.use(service =>
		service.run({
			eventName: env.eventName,
			readEvent: readEventText(env.eventPath).pipe(
				Effect.provideService(FileSystem.FileSystem, fs)
			),
			...(mode.value === 'publish'
				? {
						readPrior: (event: PullRequestEvent) =>
							readPrior(event).pipe(
								Effect.tap(marker => Ref.set(priorRuns, marker?.runs ?? 0)),
								Effect.provideContext(priorServices)
							),
					}
				: {}),
		})
	)
	const publish =
		mode.value === 'publish'
			? yield* publishOutcome(outcome, yield* Ref.get(priorRuns), env, masked)
			: undefined
	const wallMillis = (yield* Clock.currentTimeMillis) - startedAt
	yield* Console.log(formatLogLine(outcome))
	if (publish) yield* Console.log(formatPublishLogLine(publish))
	yield* writeSummary(
		env.summaryPath,
		formatSummary(outcome, {
			engineCommit: env.engineCommit,
			...(publish ? { publish } : {}),
		})
	)
	yield* writeResult(
		env.resultPath,
		formatResult(outcome, {
			...env,
			wallMillis,
			masked,
			...(publish ? { publish } : {}),
		})
	)
	if (outcome.status === 'invalid-config')
		return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
	if (outcome.status === 'failed')
		return yield* new ActionExit({ code: FAILED_EXIT_CODE })
	return yield* Effect.void
})

BunRuntime.runMain(
	runAction.pipe(Effect.provide(ActionLive), Effect.provide(PlatformLive))
)
