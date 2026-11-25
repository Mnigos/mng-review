import { Context, Effect, Layer } from 'effect'
import { GitHubStatusService } from '../../../platform/github-status.service'
import type { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	StatusReportService,
	StatusReportServiceLive,
} from '../../status/application/status-report.service'
import { toCommitStatus } from '../../status/domain/status.helper'
import type { ReplyStanding } from '../domain/bot-thread.helper'
import {
	ThreadReplyService,
	ThreadReplyServiceLive,
} from './thread-reply.service'

/** What a reply-only run whose summary write failed still writes: the status and the label. */
export interface FailClosedInput {
	readonly pullNumber: number
	readonly head: string
	readonly openBugs: number
	/** Threads the summary kept waiting before the run and would keep after it. */
	readonly before: number
	readonly after: number
	/** Threads the run held waiting for itself only, which set the status but not the label. */
	readonly held: number
	/** A list read of the run left a null node out, the write's own included. */
	readonly incomplete: boolean
	/**
	 * The newest summary marker, which the failed write leaves in place, keeps the hold an incomplete
	 * write left (`isIncompleteMarker`), whether or not this run's list reads were complete.
	 */
	readonly unfinished: boolean
	/**
	 * What the summary's newest render judged or, when the write failed before rendering, what it
	 * would judge from the newest summary's marker; unset when that read failed too.
	 */
	readonly standing?: ReplyStanding
}

/**
 * What a reply-only run does after its summary write failed: the status and the label from what
 * it computed, since the find step will not list the pull request again.
 */
export class ReplyFailService extends Context.Service<
	ReplyFailService,
	{
		/**
		 * A thread that waits sets `needs owner` and `failure`; with none the status stays. A run whose
		 * list reads left a node out writes the status of the standing its newest render judged
		 * instead, with no standing that of its waits and thread bugs. Such a run's write leaves an
		 * unfinished marker, so it writes as the success path does over one
		 * (`setIncompleteMarkerStatus`): an open bug it saw sets `failure`, a `success` becomes
		 * `pending`, and an unfinished standing never writes `error` over a `failure`. A complete run
		 * with no wait whose newest marker keeps that hold (`unfinished`) writes the same way, so a
		 * `success` that marker cannot back does not stay.
		 */
		readonly failClosed: (
			input: FailClosedInput
		) => Effect.Effect<void, never, OwnedIdentities>
	}
>()('mng-review/ReplyFailService') {}

export const ReplyFailServiceLive = Layer.effect(
	ReplyFailService,
	Effect.gen(function* () {
		const statuses = yield* StatusReportService
		const github = yield* GitHubStatusService
		const conversation = yield* ThreadReplyService

		const failClosed = Effect.fn('ReplyFailService.failClosed')(function* (
			input: FailClosedInput
		) {
			const waits = input.after + input.held
			const standing = input.standing ?? {
				verdict: waits > 0 ? 'needs owner' : 'ready',
				openBugs: input.openBugs,
				finished: true,
			}
			if (input.incomplete || (input.unfinished && waits === 0))
				yield* statuses.setIncompleteMarkerStatus(
					input.head,
					toCommitStatus(standing.verdict, standing.openBugs, standing.finished)
				)
			else if (waits > 0)
				yield* github
					.setStatus({
						sha: input.head,
						...toCommitStatus('needs owner', input.openBugs, true),
					})
					.pipe(Effect.ignore)
			yield* conversation.syncLabel(input.pullNumber, input.before, input.after)
		})

		return { failClosed }
	})
).pipe(
	Layer.provide(Layer.mergeAll(ThreadReplyServiceLive, StatusReportServiceLive))
)
