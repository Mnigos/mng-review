#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import type { ConfigError } from '@mng-review/domain'
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
	type GitHubConfig,
	GitHubReadConfigLive,
	GitHubStatusServiceLive,
	GitHubWriteConfigLive,
	PublishServiceLive,
	StatusReportServiceLive,
	StatusSweepServiceLive,
	SummaryCommentServiceLive,
	ThreadRecheckServiceLive,
	ThreadResolutionServiceLive,
} from '@mng-review/github'
import { Clock, Console, Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { PrepareRunServiceLive } from './application/prepare-run.service'
import { PublishRunServiceLive } from './application/publish-run.service'
import { ShadowRunServiceLive } from './application/shadow-run.service'
import type { ShadowOutcome } from './application/shadow-run.types'
import {
	MODE_VARIABLE,
	maskAppToken,
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
import {
	failPublishConfig,
	runPublishStep,
} from './presentation/handlers/publish-step.handler'
import {
	runReviewStep,
	runShadowStep,
} from './presentation/handlers/review-step.handler'
import {
	failSweepConfig,
	runSweepStep,
} from './presentation/handlers/sweep-step.handler'
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

/** The rules at the base commit over git in the caller's checkout. */
const RulesLive = RulesServiceLive.pipe(Layer.provideMerge(GitServiceLive))

/**
 * The GitHub API and status calls over one token: the read rules in prepare mode, the write rules
 * in publish and sweep mode. Built only in those modes.
 */
const toGitHubLive = (config: Layer.Layer<GitHubConfig, ConfigError>) =>
	Layer.mergeAll(GitHubApiServiceLive, GitHubStatusServiceLive).pipe(
		Layer.provideMerge(config)
	)

/** Publishing, the sticky summary, thread resolution and the status over one token. */
const toPublisherLive = (config: Layer.Layer<GitHubConfig, ConfigError>) =>
	Layer.mergeAll(PublishServiceLive, StatusReportServiceLive).pipe(
		Layer.provideMerge(SummaryCommentServiceLive),
		Layer.provide(ThreadResolutionServiceLive),
		Layer.provideMerge(toGitHubLive(config))
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
	Layer.provideMerge(toPublisherLive(GitHubReadConfigLive)),
	Layer.provideMerge(RulesLive)
)

/** The publish step: the publisher over the write token and the rules; no endpoint, no model. */
const PublishLive = PublishRunServiceLive.pipe(
	Layer.provideMerge(toPublisherLive(GitHubWriteConfigLive)),
	Layer.provideMerge(RulesLive)
)

/** The status sweep over the write token, with the rules of the default branch checkout. */
const SweepLive = StatusSweepServiceLive.pipe(
	Layer.provideMerge(toGitHubLive(GitHubWriteConfigLive)),
	Layer.provideMerge(RulesLive)
)

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
	if (mode.value === 'sweep')
		return yield* maskAppToken().pipe(
			Effect.andThen(runSweepStep.pipe(Effect.provide(SweepLive))),
			Effect.catchTag('ConfigError', failSweepConfig)
		)
	if (mode.value === 'prepare')
		return yield* runPrepareStep.pipe(Effect.provide(PrepareLive))
	if (mode.value === 'review')
		return yield* runReviewStep.pipe(Effect.provide(ReviewLive))
	if (mode.value === 'publish')
		return yield* maskAppToken().pipe(
			Effect.andThen(runPublishStep.pipe(Effect.provide(PublishLive))),
			Effect.catchTag('ConfigError', failPublishConfig)
		)
	return yield* runShadowStep.pipe(Effect.provide(ReviewSessionLive))
})

BunRuntime.runMain(runAction.pipe(Effect.provide(PlatformLive)))
