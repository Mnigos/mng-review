import { gateRun } from '@mng-review/domain'
import {
	EndpointProbeService,
	ReviewRunService,
	RulesService,
} from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { parsePullRequestEvent } from '../infrastructure/pull-request-event.parser'
import type {
	PullRequestEvent,
	ShadowOutcome,
	ShadowRunInput,
} from './shadow-run.types'

/** Events whose payload carries a pull request. */
const PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target'] as const
export const FORK_REASON = 'fork pull request; the workflow never reviews forks'

/**
 * Reviews one pull request in shadow mode. Forks are skipped before anything else; the rules are
 * read from the base commit, never from the pull request's head; the `skip` rules decide before
 * the endpoint is probed; an endpoint that fails the probe ends the run neutral. Nothing is posted.
 */
export class ShadowRunService extends Context.Service<
	ShadowRunService,
	{
		readonly run: (input: ShadowRunInput) => Effect.Effect<ShadowOutcome>
	}
>()('mng-review/ShadowRunService') {}

export const ShadowRunServiceLive = Layer.effect(
	ShadowRunService,
	Effect.gen(function* () {
		const rulesService = yield* RulesService
		const reviewRun = yield* ReviewRunService
		const endpointProbe = yield* EndpointProbeService

		const review = Effect.fn('ShadowRunService.review')(function* (
			event: PullRequestEvent
		) {
			if (event.pr.fork)
				return { status: 'skipped', reason: FORK_REASON, event } as const
			const rules = yield* rulesService.load(event.baseSha)
			const skipped = gateRun(rules.config, event.pr)
			if (skipped !== undefined)
				return { status: 'skipped', reason: skipped, event } as const
			const probe = yield* endpointProbe.probe()
			if (probe.status === 'offline')
				return { status: 'offline', reason: probe.reason, event } as const
			const report = yield* reviewRun.run({
				rules,
				baseRef: event.baseSha,
				headRef: event.headSha,
				pr: event.pr,
			})
			return { status: 'reviewed', event, report, rules } as const
		})

		const run = Effect.fn('ShadowRunService.run')(function* (
			input: ShadowRunInput
		) {
			if (!PULL_REQUEST_EVENTS.some(name => name === input.eventName))
				return {
					status: 'skipped',
					reason: `${input.eventName || 'unknown'} is not a pull request event`,
				} satisfies ShadowOutcome
			return yield* input.readEvent.pipe(
				Effect.flatMap(parsePullRequestEvent),
				Effect.flatMap(event =>
					review(event).pipe(
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
				),
				Effect.catchTag('ConfigError', error =>
					Effect.succeed({
						status: 'invalid-config',
						source: error.source,
						reason: error.reason,
					} satisfies ShadowOutcome)
				)
			)
		})

		return { run }
	})
)
