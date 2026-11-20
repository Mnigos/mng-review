import {
	EndpointProbeService,
	ReviewRunService,
	RulesService,
} from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { PrepareRunService } from './prepare-run.service'
import type {
	PreparedRun,
	ReadyRun,
	ShadowOutcome,
	ShadowRunInput,
} from './shadow-run.types'

/**
 * Reviews one pull request after its checks (`PrepareRunService`): the rules at the base commit,
 * the endpoint probe, then the review. An endpoint that fails the probe ends the run neutral.
 * Nothing is posted. `run` is shadow mode: the checks and the review in one process.
 */
export class ShadowRunService extends Context.Service<
	ShadowRunService,
	{
		readonly review: (prepared: PreparedRun) => Effect.Effect<ShadowOutcome>
		readonly run: (input: ShadowRunInput) => Effect.Effect<ShadowOutcome>
	}
>()('mng-review/ShadowRunService') {}

export const ShadowRunServiceLive = Layer.effect(
	ShadowRunService,
	Effect.gen(function* () {
		const rulesService = yield* RulesService
		const reviewRun = yield* ReviewRunService
		const endpointProbe = yield* EndpointProbeService
		const preparer = yield* PrepareRunService

		const reviewReady = Effect.fn('ShadowRunService.reviewReady')(function* (
			ready: ReadyRun
		) {
			const { event, prior } = ready
			const rules = ready.rules ?? (yield* rulesService.load(event.baseSha))
			const probe = yield* endpointProbe.probe()
			if (probe.status === 'offline')
				return { status: 'offline', reason: probe.reason, event } as const
			const report = yield* reviewRun.run({
				rules,
				baseRef: event.baseSha,
				headRef: event.headSha,
				pr: event.pr,
				...(prior?.head && event.pr.trigger === 'auto'
					? { since: prior.head }
					: {}),
			})
			return { status: 'reviewed', event, report, rules } as const
		})

		const review = Effect.fn('ShadowRunService.review')(function* (
			prepared: PreparedRun
		) {
			if (prepared.status !== 'ready') return prepared
			const { event } = prepared
			return yield* reviewReady(prepared).pipe(
				Effect.catchTags({
					ConfigError: error =>
						Effect.succeed({
							status: 'invalid-config',
							source: error.source,
							reason: error.reason,
							event,
						} satisfies ShadowOutcome),
					GitError: error =>
						Effect.succeed({
							status: 'failed',
							reason: `git: ${error.message}`,
							event,
						} satisfies ShadowOutcome),
				})
			)
		})

		const run = Effect.fn('ShadowRunService.run')(function* (
			input: ShadowRunInput
		) {
			return yield* review(yield* preparer.prepare(input))
		})

		return { review, run }
	})
)
