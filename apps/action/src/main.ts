#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import {
	EndpointProbeServiceLive,
	GitServiceLive,
	GitWorkdir,
	ReviewRunServiceLive,
	RulesServiceLive,
	TokenLedgerLive,
} from '@mng-review/engine'
import {
	GitHubApiServiceLive,
	GitHubConfigLive,
	PublishServiceLive,
} from '@mng-review/github'
import { Clock, Console, Effect, FileSystem, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import {
	PublishRunService,
	PublishRunServiceLive,
} from './application/publish-run.service'
import {
	ShadowRunService,
	ShadowRunServiceLive,
} from './application/shadow-run.service'
import type { ShadowOutcome } from './application/shadow-run.types'
import {
	MODE_VARIABLE,
	maskEndpoint,
	modeConfig,
	readEventText,
	repoDirConfig,
	runnerEnvironmentConfig,
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
const PublishLive = PublishRunServiceLive.pipe(
	Layer.provide(PublishServiceLive),
	Layer.provide(GitHubApiServiceLive.pipe(Layer.provideMerge(GitHubConfigLive)))
)

/** Publishes the outcome; a missing token or repository is reported, never fatal. */
const publishOutcome = (
	outcome: ShadowOutcome,
	engineCommit: string | undefined
) =>
	PublishRunService.use(service => service.run(outcome, { engineCommit })).pipe(
		Effect.provide(PublishLive),
		Effect.catchTag('ConfigError', error =>
			Effect.succeed({ status: 'failed', reason: error.message } as const)
		)
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
			reason: 'must be shadow or publish',
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
	const fs = yield* FileSystem.FileSystem
	const outcome = yield* ShadowRunService.use(service =>
		service.run({
			eventName: env.eventName,
			readEvent: readEventText(env.eventPath).pipe(
				Effect.provideService(FileSystem.FileSystem, fs)
			),
		})
	)
	const publish =
		mode.value === 'publish'
			? yield* publishOutcome(outcome, env.engineCommit)
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
