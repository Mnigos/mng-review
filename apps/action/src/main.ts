#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import type { ConfigError } from '@mng-review/domain'
import {
	EndpointProbeServiceLive,
	FloorDiffServiceLive,
	GitServiceLive,
	GitWorkdir,
	RecheckServiceLive,
	ReviewRunServiceLive,
	RulesServiceLive,
	TokenLedgerLive,
} from '@mng-review/engine'
import {
	CommandAuthorizeServiceLive,
	GitHubApiServiceLive,
	GitHubReviewServiceLive,
	GitHubRiskServiceLive,
	type GitHubConfig,
	GitHubReadConfigLive,
	GitHubStatusServiceLive,
	GitHubWriteConfigLive,
	PublishServiceLive,
	ReplyDecisionServiceLive,
	ReplyFindServiceLive,
	ReplyPublishServiceLive,
	RiskFinishServiceLive,
	RiskReadServiceLive,
	RiskStartServiceLive,
	StatusReportServiceLive,
	StatusSweepServiceLive,
	SummaryReviewServiceLive,
	ThreadRecheckServiceLive,
	ThreadReplyServiceLive,
	ThreadResolutionServiceLive,
} from '@mng-review/github'
import { Clock, Console, Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { ConverseRunServiceLive } from './application/converse-run.service'
import { PrepareRunServiceLive } from './application/prepare-run.service'
import { PublishRunServiceLive } from './application/publish-run.service'
import { RiskRunServiceLive } from './application/risk-run.service'
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
import {
	denyAuthorizeConfig,
	runAuthorizeStep,
} from './presentation/handlers/authorize-step.handler'
import {
	failFindConfig,
	runFindStep,
} from './presentation/handlers/find-step.handler'
import { runPrepareStep } from './presentation/handlers/prepare-step.handler'
import {
	failPublishConfig,
	publishMissingOutcome,
	runPublishStep,
} from './presentation/handlers/publish-step.handler'
import {
	failReserveConfig,
	runReserveStep,
} from './presentation/handlers/reserve-step.handler'
import {
	runReviewStep,
	runShadowStep,
} from './presentation/handlers/review-step.handler'
import {
	failRiskCleanupConfig,
	runRiskCleanupStep,
} from './presentation/handlers/risk-cleanup-step.handler'
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
 * The GitHub API, review and status calls over one token: the read rules in prepare mode, the write rules
 * in publish and sweep mode. Built only in those modes.
 */
const toGitHubLive = (config: Layer.Layer<GitHubConfig, ConfigError>) =>
	Layer.mergeAll(
		GitHubApiServiceLive,
		GitHubReviewServiceLive,
		GitHubStatusServiceLive,
		GitHubRiskServiceLive
	).pipe(Layer.provideMerge(config))

/** Publishing, the summary review, thread resolution, replies and the status over one token. */
const toPublisherLive = (config: Layer.Layer<GitHubConfig, ConfigError>) =>
	Layer.mergeAll(
		PublishServiceLive,
		StatusReportServiceLive,
		ThreadReplyServiceLive,
		ReplyPublishServiceLive
	).pipe(
		Layer.provideMerge(SummaryReviewServiceLive),
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

/**
 * The review step also proposes the re-check and decides on replies over the model, and for the
 * reply schedule only decides; no GitHub.
 */
const ReviewLive = ConverseRunServiceLive.pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			ThreadRecheckServiceLive.pipe(Layer.provide(RecheckServiceLive)),
			ReplyDecisionServiceLive
		)
	),
	Layer.provideMerge(ReviewSessionLive)
)

/** The prepare step: the checks and the GitHub reads over the read token; no endpoint, no model. */
const PrepareLive = Layer.mergeAll(
	PrepareRunServiceLive,
	ReplyFindServiceLive
).pipe(
	Layer.provideMerge(toPublisherLive(GitHubReadConfigLive)),
	Layer.provideMerge(RulesLive)
)

/**
 * The risk rating around a publish: its reads (statuses, timeline, the risk comment, the floor
 * diff from git), step 1 and the grant, over the publisher's token.
 */
const RiskLive = RiskRunServiceLive.pipe(
	Layer.provide(
		Layer.mergeAll(RiskStartServiceLive, RiskFinishServiceLive).pipe(
			Layer.provideMerge(RiskReadServiceLive),
			Layer.provide(FloorDiffServiceLive)
		)
	)
)

/** The publish step: the publisher over the write token and the rules; no endpoint, no model. */
const PublishLive = PublishRunServiceLive.pipe(
	Layer.provideMerge(RiskLive),
	Layer.provideMerge(toPublisherLive(GitHubWriteConfigLive)),
	Layer.provideMerge(RulesLive)
)

/** The authorize step: the comment checks over the read token and the default branch's rules. */
const AuthorizeLive = CommandAuthorizeServiceLive.pipe(
	Layer.provideMerge(SummaryReviewServiceLive),
	Layer.provideMerge(toGitHubLive(GitHubReadConfigLive)),
	Layer.provideMerge(RulesLive)
)

/** The reserve step: the gates at the base rules and the count, over the write token. */
const ReserveLive = PrepareRunServiceLive.pipe(
	Layer.provideMerge(SummaryReviewServiceLive),
	Layer.provideMerge(toGitHubLive(GitHubWriteConfigLive)),
	Layer.provideMerge(RulesLive)
)

/** The find step: the reply reads over the read token and the default branch's rules; no model. */
const FindLive = ReplyFindServiceLive.pipe(
	Layer.provideMerge(SummaryReviewServiceLive),
	Layer.provideMerge(toGitHubLive(GitHubReadConfigLive)),
	Layer.provideMerge(RulesLive)
)

/** The status sweep over the write token, with the rules of the default branch checkout. */
const SweepLive = StatusSweepServiceLive.pipe(
	Layer.provideMerge(toGitHubLive(GitHubWriteConfigLive)),
	Layer.provideMerge(RulesLive)
)

/** The risk cleanup over the write token: the revocation, the risk reads and the rules. */
const RiskCleanupLive = RiskFinishServiceLive.pipe(
	Layer.provideMerge(RiskReadServiceLive),
	Layer.provide(FloorDiffServiceLive),
	Layer.provideMerge(toPublisherLive(GitHubWriteConfigLive)),
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
		reason:
			'must be shadow, prepare, review, publish, sweep, authorize, reserve, find or risk-cleanup',
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
	if (mode.value === 'risk-cleanup')
		return yield* maskAppToken().pipe(
			Effect.andThen(runRiskCleanupStep.pipe(Effect.provide(RiskCleanupLive))),
			Effect.catchTag('ConfigError', failRiskCleanupConfig)
		)
	if (mode.value === 'authorize')
		return yield* runAuthorizeStep.pipe(
			Effect.provide(AuthorizeLive),
			Effect.catchTag('ConfigError', denyAuthorizeConfig)
		)
	if (mode.value === 'reserve')
		return yield* maskAppToken().pipe(
			Effect.andThen(runReserveStep.pipe(Effect.provide(ReserveLive))),
			Effect.catchTag('ConfigError', failReserveConfig)
		)
	if (mode.value === 'find')
		return yield* runFindStep.pipe(
			Effect.provide(FindLive),
			Effect.catchTag('ConfigError', failFindConfig)
		)
	if (mode.value === 'prepare')
		return yield* runPrepareStep.pipe(Effect.provide(PrepareLive))
	if (mode.value === 'review')
		return yield* runReviewStep.pipe(Effect.provide(ReviewLive))
	if (mode.value === 'publish')
		return yield* maskAppToken().pipe(
			Effect.andThen(publishMissingOutcome),
			Effect.flatMap(done =>
				done ? Effect.void : runPublishStep.pipe(Effect.provide(PublishLive))
			),
			Effect.catchTag('ConfigError', failPublishConfig)
		)
	return yield* runShadowStep.pipe(Effect.provide(ReviewSessionLive))
})

BunRuntime.runMain(runAction.pipe(Effect.provide(PlatformLive)))
