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
import { Clock, Console, Effect, FileSystem, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import {
	ShadowRunService,
	ShadowRunServiceLive,
} from './application/shadow-run.service'
import {
	maskEndpoint,
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
import { formatLogLine, formatSummary } from './presentation/summary.formatter'

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
const ActionLive = ShadowRunServiceLive.pipe(
	Layer.provide(
		Layer.mergeAll(ReviewRunServiceLive, EndpointProbeServiceLive).pipe(
			Layer.provideMerge(RulesServiceLive),
			Layer.provideMerge(GitServiceLive),
			Layer.provideMerge(TokenLedgerLive)
		)
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
	const fs = yield* FileSystem.FileSystem
	const outcome = yield* ShadowRunService.use(service =>
		service.run({
			eventName: env.eventName,
			readEvent: readEventText(env.eventPath).pipe(
				Effect.provideService(FileSystem.FileSystem, fs)
			),
		})
	)
	const wallMillis = (yield* Clock.currentTimeMillis) - startedAt
	yield* Console.log(formatLogLine(outcome))
	yield* writeSummary(
		env.summaryPath,
		formatSummary(outcome, { engineCommit: env.engineCommit })
	)
	yield* writeResult(
		env.resultPath,
		formatResult(outcome, { ...env, wallMillis }),
		masked
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
