import {
	EndpointProbeService,
	GitService,
	RulesService,
} from '@mng-review/engine'
import { ReplyDecisionService } from '@mng-review/github'
import { Context, Effect, Layer } from 'effect'
import type { PreparedRun, ReadyRun, ShadowOutcome } from './shadow-run.types'

/**
 * The review step of a reply schedule run: the endpoint probe, then the decisions on the replies
 * the prepare step read, between the merge base and the head. No finder and no re-check runs. An
 * offline endpoint ends the run offline, no decision at all skips it, and a rules or git failure
 * becomes the run's outcome.
 */
export class ConverseRunService extends Context.Service<
	ConverseRunService,
	{
		readonly review: (prepared: PreparedRun) => Effect.Effect<ShadowOutcome>
	}
>()('mng-review/ConverseRunService') {}

export const ConverseRunServiceLive = Layer.effect(
	ConverseRunService,
	Effect.gen(function* () {
		const rulesService = yield* RulesService
		const endpointProbe = yield* EndpointProbeService
		const git = yield* GitService
		const replyDecisions = yield* ReplyDecisionService

		const decide = Effect.fn('ConverseRunService.decide')(function* (
			ready: ReadyRun
		) {
			const { event } = ready
			const rules = ready.rules ?? (yield* rulesService.load(event.baseSha))
			const probe = yield* endpointProbe.probe()
			if (probe.status === 'offline')
				return { status: 'offline', reason: probe.reason, event } as const
			const mergeBase = yield* git.mergeBase(event.baseSha, event.headSha)
			const replies = yield* replyDecisions.decide({
				rules,
				pr: event.pr,
				head: event.headSha,
				mergeBase,
				replies: ready.replies ?? [],
				threads: ready.threads,
			})
			if (!replies || replies.decided.length === 0)
				return {
					status: 'skipped',
					reason: 'no reply could be decided',
					event,
				} as const
			return { status: 'replied', event, replies } as const
		})

		const review = Effect.fn('ConverseRunService.review')(function* (
			prepared: PreparedRun
		) {
			if (prepared.status !== 'ready') return prepared
			const { event } = prepared
			return yield* decide(prepared).pipe(
				Effect.map((outcome): ShadowOutcome => outcome),
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

		return { review }
	})
)
