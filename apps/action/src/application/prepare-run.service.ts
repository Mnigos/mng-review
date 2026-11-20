import { gateRun } from '@mng-review/domain'
import { RulesService } from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { parsePullRequestEvent } from '../infrastructure/pull-request-event.parser'
import type {
	PreparedRun,
	PriorRun,
	PullRequestEvent,
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
 * The checks before the endpoint is probed: the event, forks before anything else, the rules from
 * the base commit (never from the pull request's head), the `skip` rules, the earlier runs and the
 * run limit. It calls no model; the threads are read only once the run goes on.
 */
export class PrepareRunService extends Context.Service<
	PrepareRunService,
	{
		readonly prepare: (input: ShadowRunInput) => Effect.Effect<PreparedRun>
	}
>()('mng-review/PrepareRunService') {}

export const PrepareRunServiceLive = Layer.effect(
	PrepareRunService,
	Effect.gen(function* () {
		const rulesService = yield* RulesService

		const check = Effect.fn('PrepareRunService.check')(function* (
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
			const threads = input.readThreads ? yield* input.readThreads(event) : []
			return {
				status: 'ready',
				event,
				threads,
				rules,
				...(prior ? { prior } : {}),
			} as const
		})

		const prepare = Effect.fn('PrepareRunService.prepare')(function* (
			input: ShadowRunInput
		) {
			if (!PULL_REQUEST_EVENTS.some(name => name === input.eventName))
				return {
					status: 'skipped',
					reason: `${input.eventName || 'unknown'} is not a pull request event`,
				} satisfies PreparedRun
			return yield* input.readEvent.pipe(
				Effect.flatMap(parsePullRequestEvent),
				Effect.flatMap(event =>
					check(event, input).pipe(
						Effect.catchTags({
							ConfigError: error =>
								Effect.succeed({
									status: 'invalid-config',
									source: error.source,
									reason: error.reason,
									event,
								} satisfies PreparedRun),
							GitError: error =>
								Effect.succeed({
									status: 'failed',
									reason: `git: ${error.message}`,
									event,
								} satisfies PreparedRun),
						})
					)
				),
				Effect.catchTag('ConfigError', error =>
					Effect.succeed({
						status: 'invalid-config',
						source: error.source,
						reason: error.reason,
					} satisfies PreparedRun)
				)
			)
		})

		return { prepare }
	})
)
