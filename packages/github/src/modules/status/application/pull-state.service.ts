import { Context, Effect, Layer } from 'effect'
import type { PullRequestReview } from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { isReadIncomplete } from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { ThreadReplyService } from '../../publish/application/thread-reply.service'
import { isOpenBug, toBotThread } from '../../publish/domain/bot-thread.helper'
import {
	getDuplicateSummaries,
	getListedWaiting,
	toSummaryComments,
} from '../../publish/domain/summary-comment.helper'
import { isIncompleteMarker } from '../../publish/domain/summary-marker.helper'
import {
	getPriorSummary,
	toSummaryReviews,
} from '../../publish/domain/summary-review.helper'
import { toResolvers } from '../../publish/domain/thread-conversation.helper'
import type { PullState } from '../domain/status-sweep.types'
import {
	getSweptFinished,
	getUnbackedRequests,
	getUnthreadedBugs,
} from '../domain/sweep-review.helper'

/** The pull request to read, the reviews already read for it, and who clears a waiting thread. */
export interface PullStateInput {
	readonly pullNumber: number
	/** The pull request's head, as the caller read it. */
	readonly head: string
	/**
	 * The reviews, read before anything here, so a change request posted after that read is never
	 * among `stale`.
	 */
	readonly reviews: readonly PullRequestReview[]
	/** `commands.allow` of the default branch. */
	readonly allow: readonly string[]
}

/**
 * The judgment the status sweep and the change request lift share: from the reviews, the
 * conversation comments and the review threads of a pull request, what is open on it, whether
 * nothing backs the current identity's change requests, and how far the last full run got. It
 * writes nothing; every read goes through the GitHub services it is given, so a sweep that
 * journals them compares this pass with a later one.
 *
 * The summary is the newest summary review of an owned identity, or with none the old sticky
 * comment; while the current identity has more than one visible sticky comment and no review, the
 * pull request is `duplicate` and nothing is judged. A thread a summary marker says waits for the
 * owner stays waiting until an admin or an allowed login resolves it. When no open bug thread, no
 * bug without a thread in the newest marker (on whatever head it is) and nothing waiting remain,
 * finished or not, the current identity's change requests in `reviews` are stale: every one with
 * the marker on the head, only those off the head with the marker on another. `bugs`, which sets
 * the status, counts the marker's bugs without a thread only on its own head
 * (`getUnthreadedBugs`). None is stale while a list read of the
 * run left a node out or the marker is one an incomplete write left (`isIncompleteMarker`).
 */
export class PullStateService extends Context.Service<
	PullStateService,
	{
		readonly read: (
			input: PullStateInput
		) => Effect.Effect<PullState, GitHubApiError, OwnedIdentities>
	}
>()('mng-review/PullStateService') {}

export const PullStateServiceLive = Layer.effect(
	PullStateService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const conversation = yield* ThreadReplyService

		const read = Effect.fn('PullStateService.read')(function* (
			input: PullStateInput
		) {
			const { pullNumber, head, reviews, allow } = input
			const { current, identities } = yield* OwnedIdentities
			const comments = yield* api.listComments(pullNumber)
			const raw = yield* api.listReviewThreads(pullNumber)
			const threads = raw.flatMap(
				thread => toBotThread(thread, identities) ?? []
			)
			// Reads only: a resolved bug with an unsettled answer counts open, read whole when unknown.
			const openBugs = (yield* conversation.resolveUnsettled(
				threads,
				raw
			)).filter(isOpenBug).length
			const summaryReviews = toSummaryReviews(reviews, identities, current)
			const summaries = toSummaryComments(comments, identities, current)
			// With two old sticky comments of the current identity, the oldest may be a stale finished one.
			if (
				summaryReviews.length === 0 &&
				getDuplicateSummaries(summaries).length > 0
			)
				return { kind: 'duplicate' } satisfies PullState
			const summary = getPriorSummary(summaryReviews, summaries)
			const marker = summary?.marker
			// Hidden summaries still list, and threads the bot sent to the owner still wait, edited or resolved.
			const waiting = [
				...new Set([
					...getListedWaiting([...reviews, ...comments], identities),
					...(yield* conversation.getSentToOwner(raw)),
				]),
			]
			const cleared = yield* conversation.getCleared({
				waiting,
				resolvers: toResolvers(raw),
				threads: raw,
				allow,
			})
			const uncleared = waiting.filter(id => !cleared.has(id)).length
			const bugs = openBugs + getUnthreadedBugs(marker, head)
			// A marker's bugs without a thread back a change request on any head: after a push the new
			// head may never be reviewed, and only a later marker that no longer lists them clears them.
			const backing = openBugs + (marker?.unthreadedBugs ?? 0) + uncleared
			const unfinished = isIncompleteMarker(marker)
			return {
				kind: 'read',
				// A list read that left a node out may miss an open thread, so no request is stale.
				stale: (yield* isReadIncomplete)
					? []
					: getUnbackedRequests(reviews, current, head, marker, backing === 0),
				bugs,
				uncleared,
				unfinished,
				finished: !unfinished && getSweptFinished(summary, head),
			} satisfies PullState
		})

		return { read }
	})
)
