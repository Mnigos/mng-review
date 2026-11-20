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
	PublishServiceLive,
	StatusReportServiceLive,
	StatusSweepService,
	StatusSweepServiceLive,
	ThreadRecheckServiceLive,
	ThreadResolutionServiceLive,
	toLogText,
} from '@mng-review/github'
import { Clock, Console, Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { PrepareRunServiceLive } from './application/prepare-run.service'
import { PublishRunServiceLive } from './application/publish-run.service'
import { ShadowRunServiceLive } from './application/shadow-run.service'
import type { ShadowOutcome } from './application/shadow-run.types'
import {
	MODE_VARIABLE,
	maskEndpoint,
	modeConfig,
	repoDirConfig,
	runnerEnvironmentConfig,
	writeResult,
	writeSummary,
} from './infrastructure/runner.client'
import {
	ActionExit,
	INVALID_CONFIG_EXIT_CODE,
} from './presentation/action-exit.errors'
import { runPrepareStep } from './presentation/handlers/prepare-step.handler'
import { runPublishStep } from './presentation/handlers/publish-step.handler'
import {
	runReviewStep,
	runShadowStep,
} from './presentation/handlers/review-step.handler'
import { formatResult } from './presentation/result.formatter'
import {
	formatLogLine,
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

/** The rules at the base commit over git in the caller's checkout. */
const RulesLive = RulesServiceLive.pipe(Layer.provideMerge(GitServiceLive))

/** The GitHub API and status calls over the job token; built only in prepare, publish and sweep mode. */
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

/** Shadow mode and the review step: the checks, the probe and the review; no GitHub layer. */
const ReviewSessionLive = ShadowRunServiceLive.pipe(
	Layer.provideMerge(PrepareRunServiceLive),
	Layer.provideMerge(
		Layer.mergeAll(ReviewRunServiceLive, EndpointProbeServiceLive)
	),
	Layer.provideMerge(RulesLive),
	Layer.provideMerge(TokenLedgerLive)
)

/** The review step also proposes the re-check over the model, reading no GitHub. */
const ReviewLive = ThreadRecheckServiceLive.pipe(
	Layer.provide(RecheckServiceLive),
	Layer.provideMerge(ReviewSessionLive)
)

/** The prepare step: the checks and the GitHub reads over the read token; no endpoint, no model. */
const PrepareLive = PrepareRunServiceLive.pipe(
	Layer.provideMerge(PublisherLive),
	Layer.provideMerge(RulesLive)
)

/** The publish step: the publisher over the write token and the rules; no endpoint, no model. */
const PublishLive = PublishRunServiceLive.pipe(
	Layer.provideMerge(PublisherLive),
	Layer.provideMerge(RulesLive)
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

/** An unknown `MNG_REVIEW_MODE`: reported as an invalid configuration before anything else runs. */
const runInvalidMode = Effect.gen(function* () {
	const startedAt = yield* Clock.currentTimeMillis
	const masked = yield* maskEndpoint()
	const env = yield* runnerEnvironmentConfig
	const invalid: ShadowOutcome = {
		status: 'invalid-config',
		source: MODE_VARIABLE,
		reason: 'must be shadow, prepare, review, publish or sweep',
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
})

/**
 * Runs the step `MNG_REVIEW_MODE` names with only the layers it needs, so a step that must not
 * reach GitHub, or must not reach the model, does not compile if it asks for them.
 */
const runAction = Effect.gen(function* () {
	const mode = yield* modeConfig.pipe(Effect.option)
	if (mode._tag === 'None') return yield* runInvalidMode
	if (mode.value === 'sweep') return yield* runSweep
	if (mode.value === 'prepare')
		return yield* runPrepareStep.pipe(Effect.provide(PrepareLive))
	if (mode.value === 'review')
		return yield* runReviewStep.pipe(Effect.provide(ReviewLive))
	if (mode.value === 'publish')
		return yield* runPublishStep.pipe(Effect.provide(PublishLive))
	return yield* runShadowStep.pipe(Effect.provide(ReviewSessionLive))
})

BunRuntime.runMain(runAction.pipe(Effect.provide(PlatformLive)))
