import { gateRun } from '@mng-review/domain'
import {
	EndpointProbeService,
	ReviewRunService,
	RulesService,
} from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { parsePullRequestEvent } from '../infrastructure/pull-request-event.parser'
import type {
	PriorRun,
	PullRequestEvent,
	ShadowOutcome,
	ShadowRunInput,
} from './shadow-run.types'

/** Actions that start a run whatever the run count: a draft that became ready. */
const EXEMPT_ACTIONS = ['ready_for_review'] as const

/**
 * Why the run stops at `limits.max_runs_per_pr`, or `undefined` when it goes on: a manual trigger
 * and a pull request that just became ready for review are exempt.
 */
export function getRunLimitReason(
	prior: PriorRun | undefined,
	limit: number,
	event: Pick<PullRequestEvent, 'action' | 'pr'>
): string | undefined {
	if (!prior || prior.runs < limit || event.pr.trigger === 'manual')
		return undefined
	if (EXEMPT_ACTIONS.some(action => action === event.action)) return undefined
	return `run limit reached: ${prior.runs} of ${limit} runs on this pull request; a manual command still runs`
}

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
			event: PullRequestEvent,
			input: ShadowRunInput
		) {
			if (event.pr.fork)
				return { status: 'skipped', reason: FORK_REASON, event } as const
			const rules = yield* rulesService.load(event.baseSha)
			const skipped = gateRun(rules.config, event.pr)
			if (skipped !== undefined)
				return { status: 'skipped', reason: skipped, event } as const
			const prior = input.readPrior ? yield* input.readPrior(event) : undefined
			const limited = getRunLimitReason(
				prior,
				rules.config.limits.max_runs_per_pr,
				event
			)
			if (limited !== undefined)
				return { status: 'skipped', reason: limited, event } as const
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
				...(input.onlyAgent === undefined
					? {}
					: { onlyAgent: input.onlyAgent }),
			})
			return { status: 'reviewed', event, report, rules } as const
		})

		const run = Effect.fn('ShadowRunService.run')(function* (
			input: ShadowRunInput
		) {
			if (
				input.event === undefined &&
				!PULL_REQUEST_EVENTS.some(name => name === input.eventName)
			)
				return {
					status: 'skipped',
					reason: `${input.eventName || 'unknown'} is not a pull request event`,
				} satisfies ShadowOutcome
			const readEvent =
				input.event === undefined
					? input.readEvent.pipe(Effect.flatMap(parsePullRequestEvent))
					: Effect.succeed(input.event)
			return yield* readEvent.pipe(
				Effect.flatMap(event =>
					review(event, input).pipe(
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
