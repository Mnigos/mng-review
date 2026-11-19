#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import {
	EndpointProbeServiceLive,
	GitServiceLive,
	GitWorkdir,
	RecheckServiceLive,
	RulesService,
	ReviewRunServiceLive,
	RulesServiceLive,
	TokenLedgerLive,
} from '@mng-review/engine'
import {
	type CommandDecision,
	type CommandRun,
	CommandAuthorizeService,
	CommandAuthorizeServiceLive,
	GitHubApiService,
	GitHubApiServiceLive,
	GitHubConfigLive,
	GitHubStatusServiceLive,
	PublishService,
	PublishServiceLive,
	StatusReportServiceLive,
	StatusSweepService,
	StatusSweepServiceLive,
	ThreadRecheckServiceLive,
	toLogText,
} from '@mng-review/github'
import { Clock, Console, Effect, FileSystem, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { toCommandEvent } from './application/command-event.helper'
import {
	PublishRunService,
	PublishRunServiceLive,
} from './application/publish-run.service'
import {
	ShadowRunService,
	ShadowRunServiceLive,
} from './application/shadow-run.service'
import type {
	PullRequestEvent,
	ShadowOutcome,
} from './application/shadow-run.types'
import { parseIssueCommentEvent } from './infrastructure/issue-comment-event.parser'
import {
	type CommandSettings,
	commandConfig,
	MODE_VARIABLE,
	maskEndpoint,
	modeConfig,
	outputPathConfig,
	readEventText,
	repoDirConfig,
	runnerEnvironmentConfig,
	writeOutputs,
	writeResult,
	writeSummary,
} from './infrastructure/runner.client'
import {
	ActionExit,
	FAILED_EXIT_CODE,
	INVALID_CONFIG_EXIT_CODE,
} from './presentation/action-exit.errors'
import {
	formatAuthorizeLogLine,
	formatAuthorizeSummary,
	toAuthorizeOutputs,
} from './presentation/authorize.formatter'
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

/** Publishing over the job token; built only in publish mode, so a shadow run never needs a token. */
/** The GitHub API and status calls over the job token; built only in publish and sweep mode. */
const GitHubLive = Layer.mergeAll(
	GitHubApiServiceLive,
	GitHubStatusServiceLive
).pipe(Layer.provideMerge(GitHubConfigLive))

/** Publishing, the re-check and the status over the job token, and the publish run on top. */
const PublishLive = PublishRunServiceLive.pipe(
	Layer.provideMerge(
		Layer.mergeAll(PublishServiceLive, StatusReportServiceLive).pipe(
			Layer.provide(ThreadRecheckServiceLive),
			Layer.provideMerge(RecheckServiceLive),
			Layer.provideMerge(GitHubLive)
		)
	)
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
		Effect.provide(PublishLive),
		Effect.orElseSucceed(() => undefined)
	)

/** Publishes the outcome; a missing token or repository is reported, never fatal. */
const publishOutcome = (
	outcome: ShadowOutcome,
	engineCommit: string | undefined,
	command: CommandRun | undefined
) =>
	PublishRunService.use(service =>
		service.run(outcome, {
			engineCommit,
			...(command === undefined ? {} : { command }),
		})
	).pipe(
		Effect.provide(PublishLive),
		Effect.catchTag('ConfigError', error =>
			Effect.succeed({ status: 'failed', reason: error.message } as const)
		)
	)

/**
 * Checks a `/mng-review` comment without any secret: reads the comment from the event, the rules
 * from the default branch's checkout, and writes the outputs the review job starts from. Every
 * failure is a denied command, never a failed job.
 */
const runAuthorize = Effect.gen(function* () {
	const env = yield* runnerEnvironmentConfig
	const outputPath = yield* outputPathConfig
	const decision: CommandDecision = yield* readEventText(env.eventPath).pipe(
		Effect.flatMap(parseIssueCommentEvent),
		Effect.flatMap(comment =>
			RulesService.use(service => service.load('HEAD')).pipe(
				Effect.flatMap(rules =>
					CommandAuthorizeService.use(service =>
						service.authorize(comment, rules)
					)
				)
			)
		),
		Effect.provide(
			CommandAuthorizeServiceLive.pipe(Layer.provide(PublishLive))
		),
		Effect.catchTags({
			ConfigError: error =>
				Effect.succeed({ status: 'denied', reason: error.message } as const),
			GitError: error =>
				Effect.succeed({
					status: 'denied',
					reason: `git: ${error.message}`,
				} as const),
		})
	)
	yield* writeOutputs(outputPath, toAuthorizeOutputs(decision))
	yield* Console.log(formatAuthorizeLogLine(decision))
	yield* writeSummary(env.summaryPath, formatAuthorizeSummary(decision))
})

/** The pull request an authorized command reviews, read again from the API. */
const readCommandEvent = (settings: CommandSettings) =>
	GitHubApiService.use(api => api.getPullRequest(settings.pullNumber)).pipe(
		Effect.map(pr => toCommandEvent(pr, settings)),
		Effect.provide(PublishLive)
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
			reason: 'must be shadow, publish, sweep, authorize or command',
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
	if (mode.value === 'authorize') return yield* runAuthorize
	const command = mode.value === 'command' ? yield* commandConfig : undefined
	const commandEvent = command ? yield* readCommandEvent(command) : undefined
	const fs = yield* FileSystem.FileSystem
	const priorServices =
		yield* Effect.context<Effect.Services<ReturnType<typeof readPrior>>>()
	const outcome = yield* ShadowRunService.use(service =>
		service.run({
			eventName: env.eventName,
			readEvent: readEventText(env.eventPath).pipe(
				Effect.provideService(FileSystem.FileSystem, fs)
			),
			...(mode.value === 'shadow'
				? {}
				: {
						readPrior: (event: PullRequestEvent) =>
							readPrior(event).pipe(Effect.provideContext(priorServices)),
					}),
			...(commandEvent === undefined ? {} : { event: commandEvent }),
			...(command?.agent === undefined ? {} : { onlyAgent: command.agent }),
		})
	)
	const publish =
		mode.value === 'shadow'
			? undefined
			: yield* publishOutcome(
					outcome,
					env.engineCommit,
					command ? { agentOnly: command.agent !== undefined } : undefined
				)
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
