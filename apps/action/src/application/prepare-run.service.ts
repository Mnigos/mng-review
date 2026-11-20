import { gateRun } from '@mng-review/domain'
import { RulesService, type Rules } from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { parsePullRequestEvent } from '../infrastructure/pull-request-event.parser'
import { FORK_REASON, getRunLimitReason } from './run-gate.helper'
import type {
	PreparedRun,
	PriorRun,
	PullRequestEvent,
	ShadowRunInput,
} from './shadow-run.types'

const DRAFT_REASON = 'draft pull request; replies are answered once it is ready'
const NO_REPLY_REASON = 'no reply waits for an answer'
/** Events whose payload carries a pull request. */
const PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target'] as const

/**
 * The checks before the endpoint is probed: the event, forks before anything else, the rules from
 * the base commit (never from the pull request's head), the `skip` rules, the earlier runs and the
 * run limit. It calls no model; the threads are read only once the run goes on. A reply schedule
 * run (`converse`) is gated by drafts, forks and a reply to decide only.
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

		/** The bot's threads, then the authors' replies in them, each read only when its reader is set. */
		const readReplies = Effect.fn('PrepareRunService.readReplies')(function* (
			event: PullRequestEvent,
			rules: Rules,
			prior: PriorRun | undefined,
			input: ShadowRunInput
		) {
			const threads = input.readThreads
				? yield* input.readThreads(event, rules)
				: []
			const replies = input.readReplies
				? yield* input.readReplies(event, rules, threads, prior)
				: []
			return { threads, replies }
		})

		const check = Effect.fn('PrepareRunService.check')(function* (
			event: PullRequestEvent,
			input: ShadowRunInput
		) {
			if (event.pr.fork)
				return { status: 'skipped', reason: FORK_REASON, event } as const
			if (input.converse && event.pr.draft)
				return { status: 'skipped', reason: DRAFT_REASON, event } as const
			const rules = yield* rulesService.load(event.baseSha)
			const skipped = input.converse
				? undefined
				: gateRun(rules.config, event.pr)
			if (skipped !== undefined)
				return { status: 'skipped', reason: skipped, event } as const
			const prior = input.readPrior
				? yield* input.readPrior(event, rules)
				: undefined
			const limited = input.converse
				? undefined
				: getRunLimitReason(prior, rules.config.limits.max_runs_per_pr, event)
			if (limited !== undefined)
				return { status: 'skipped', reason: limited, event } as const
			const { threads, replies } = input.readPending
				? yield* input.readPending(event, rules)
				: yield* readReplies(event, rules, prior, input)
			if (input.converse && replies.length === 0)
				return { status: 'skipped', reason: NO_REPLY_REASON, event } as const
			return {
				status: 'ready',
				event,
				threads,
				...(replies.length > 0 ? { replies } : {}),
				rules,
				...(prior ? { prior } : {}),
			} as const
		})

		/** The checks for one event; a rules or git failure becomes the run's outcome. */
		const checkEvent = (event: PullRequestEvent, input: ShadowRunInput) =>
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

		const prepare = Effect.fn('PrepareRunService.prepare')(function* (
			input: ShadowRunInput
		) {
			if (input.event) return yield* checkEvent(input.event, input)
			if (!PULL_REQUEST_EVENTS.some(name => name === input.eventName))
				return {
					status: 'skipped',
					reason: `${input.eventName || 'unknown'} is not a pull request event`,
				} satisfies PreparedRun
			return yield* input.readEvent.pipe(
				Effect.flatMap(parsePullRequestEvent),
				Effect.flatMap(event => checkEvent(event, input)),
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
