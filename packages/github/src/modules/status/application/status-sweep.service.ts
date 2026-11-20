import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubStatusService } from '../../../platform/github-status.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	ThreadReplyService,
	ThreadReplyServiceLive,
} from '../../publish/application/thread-reply.service'
import { toBotThread } from '../../publish/domain/bot-thread.helper'
import {
	getDuplicateSummaries,
	getListedWaiting,
	getSummary,
	toSummaryComments,
} from '../../publish/domain/summary-comment.helper'
import { toResolvers } from '../../publish/domain/thread-conversation.helper'
import { toSweptStatus } from '../domain/status.helper'

/** What a sweep did. */
export interface SweepResult {
	/** Open pull requests whose head carried the bot's `MNG Review` status. */
	readonly checked: number
	readonly updated: number
	/** Pull requests the sweep could not read or update. */
	readonly failed: number
}

/**
 * Refreshes the `MNG Review` status of open pull requests whose head already carries one of an
 * owned identity, from the open bug threads of the owned identities now, so a thread resolved by hand counts. It runs no model and posts no
 * comment; pull requests the bot never reviewed are left alone. It reads the status again right
 * before it writes and leaves a newer one alone; a publish run that lands between that read and
 * the write can still be overwritten until the next sweep or push. While the current identity
 * has more than one visible summary, the status is left as it is until a write removes the extra.
 * A thread the summary marker says waits for the owner keeps the status `failure` until an admin or
 * an allowed login resolves it; the sweep never edits the summary.
 */
export class StatusSweepService extends Context.Service<
	StatusSweepService,
	{
		/** `allow` is `commands.allow` of the default branch, for who clears a waiting thread. */
		readonly sweep: (
			allow?: readonly string[]
		) => Effect.Effect<SweepResult, GitHubApiError, OwnedIdentities>
	}
>()('mng-review/StatusSweepService') {}

export const StatusSweepServiceLive = Layer.effect(
	StatusSweepService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const github = yield* GitHubStatusService
		const conversation = yield* ThreadReplyService

		/** One pull request: `unknown` when it has no status of the bot, else whether it changed. */
		const sweepOne = Effect.fn('StatusSweepService.sweepOne')(function* (
			pullNumber: number,
			head: string,
			allow: readonly string[]
		) {
			const previous = yield* github.getStatus(head)
			if (!previous) return 'unknown' as const
			const { current, identities } = yield* OwnedIdentities
			const raw = yield* api.listReviewThreads(pullNumber)
			const threads = raw.flatMap(
				thread => toBotThread(thread, identities) ?? []
			)
			const openBugs = threads.filter(
				thread => !thread.resolved && thread.marker.kind === 'bug'
			).length
			const comments = yield* api.listComments(pullNumber)
			const summaries = toSummaryComments(comments, identities, current)
			// With two summaries of the current identity, the oldest may be a stale finished one.
			if (getDuplicateSummaries(summaries).length > 0) return 'kept' as const
			const summary = getSummary(summaries)
			const marker = summary?.marker
			const onHead = marker?.head === head
			// Bugs runs on this head left without a thread still block it until a full review replaces them.
			const unthreaded = onHead ? (marker?.unthreadedBugs ?? 0) : 0
			// A marker's finished flag is its head's: a partial run on another head keeps it. A previous
			// identity's marker stopped at the switch, so off its head the status already set decides.
			const finished =
				summary?.mine || onHead ? marker?.finished && onHead : undefined
			// Hidden summaries still list, and threads the bot sent to the owner still wait, edited or resolved.
			const waiting = [
				...new Set([
					...getListedWaiting(comments, identities),
					...(yield* conversation.getSentToOwner(raw)),
				]),
			]
			const cleared = yield* conversation.getCleared({
				waiting,
				resolvers: toResolvers(raw),
				allow,
			})
			const owner = waiting.filter(id => !cleared.has(id)).length
			const next = toSweptStatus(
				previous,
				openBugs + unthreaded,
				finished,
				owner
			)
			if (!next) return 'kept' as const
			// A publish run may have set a newer status while the threads were read.
			const latest = yield* github.getStatus(head)
			if (latest?.id !== previous.id) return 'kept' as const
			yield* github.setStatus({ sha: head, ...next })
			return 'updated' as const
		})

		const sweep = Effect.fn('StatusSweepService.sweep')(function* (
			allow: readonly string[] = []
		) {
			const pulls = yield* github.listOpenPullRequests()
			const outcomes = yield* Effect.forEach(
				pulls,
				pull =>
					sweepOne(pull.number, pull.head.sha, allow).pipe(
						Effect.orElseSucceed(() => 'failed' as const)
					),
				{ concurrency: 1 }
			)
			return {
				checked: outcomes.filter(outcome => outcome !== 'unknown').length,
				updated: outcomes.filter(outcome => outcome === 'updated').length,
				failed: outcomes.filter(outcome => outcome === 'failed').length,
			}
		})

		return { sweep }
	})
).pipe(Layer.provide(ThreadReplyServiceLive))
