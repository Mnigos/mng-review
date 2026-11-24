import type { Rules } from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import type { ReviewEvent } from '../../../platform/github-review.service'
import { GitHubStatusService } from '../../../platform/github-status.service'
import { GitHubConfig } from '../../../platform/github.config'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { toCommitStatus } from '../../status/domain/status.helper'
import {
	getOwnerAnswered,
	getStandingVerdict,
	isOpenBug,
	toBotThread,
} from '../domain/bot-thread.helper'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import { CLOSING_ACTIONS, LIMITED_ACTIONS } from '../domain/publish.constants'
import type {
	AnswerCounts,
	DismissalOutcome,
	LabelOutcome,
} from '../domain/publish.types'
import { toRepliedMarker } from '../domain/summary-marker.helper'
import {
	toAnswerCounts,
	toFreshResolvers,
} from '../domain/thread-conversation.helper'
import type { Verdict } from '../presentation/summary-comment.formatter'
import { formatRepliedSummary } from '../presentation/summary-reply.formatter'
import { toBlobLinks } from '../presentation/thread-comment.formatter'
import type { PublishReplies, PublishTarget } from './publish.service.types'
import { ReplyCheckService, ReplyCheckServiceLive } from './reply-check.service'
import { SummaryReviewService } from './summary-review.service'
import type { SummaryWriteError } from './summary-review.service.types'
import {
	ThreadPlaceService,
	ThreadPlaceServiceLive,
} from './thread-place.service'
import {
	ThreadReplyService,
	ThreadReplyServiceLive,
} from './thread-reply.service'

/** A reply-only run to publish: the review's decisions and the rules at the base commit. */
export interface ReplyPublishInput extends PublishTarget {
	readonly rules: Rules
	readonly replies: PublishReplies
}

/** What a reply-only run did. */
export interface ReplyPublishResult {
	readonly verdict: Verdict
	/** The state the summary review was posted or edited in, before any dismissal. */
	readonly event: ReviewEvent
	/** Stale owned change requests and approvals dismissed after the write, and those that failed. */
	readonly dismissal: DismissalOutcome
	/** The run's own review was dismissed after a push landed right after the write; unset is `false`. */
	readonly outlived?: boolean
	readonly openBugs: number
	/**
	 * Severities of the resolved, confirmed bug threads a dispatched reply kept open (a non-closing
	 * answer): they count as open, and the thread raise reads them since GitHub may still show them
	 * resolved.
	 */
	readonly reopened?: readonly string[]
	readonly answered: AnswerCounts
	/** Threads that wait for the owner after the run. */
	readonly waiting: number
	readonly label: LabelOutcome
	/** The run count, unchanged. */
	readonly run: number
	/** Whether the `MNG Review` status was set. */
	readonly status: boolean
	/** Threads whose newest app answer is still unsettled after the run; any fails the job. */
	readonly unsettled: number
}

/** What a reply-only run whose summary write failed still writes: the status and the label. */
interface FailClosedInput {
	readonly pullNumber: number
	readonly head: string
	readonly openBugs: number
	/** Threads waiting before and after the run. */
	readonly before: number
	readonly after: number
}

/** The open bugs, finished flag and verdict of the summary's head after a reply-only run. */
function toStanding(marker: SummaryMarker, head: string, threadBugs: number) {
	const onHead = marker.head === head
	const openBugs = threadBugs + (onHead ? (marker.unthreadedBugs ?? 0) : 0)
	const finished = marker.finished === true && onHead
	const waiting = marker.needsOwner?.length ?? 0
	return {
		openBugs,
		finished,
		verdict: getStandingVerdict(openBugs, finished, waiting),
	}
}

/**
 * Publishes a reply-only run, which reviewed nothing, with the checks of a push run's publishing:
 * answers the review's decisions after a fresh read of the bot's threads and publishing's own git
 * check of the closing ones (`ReplyCheckService`, then `ThreadReplyService.apply`, which
 * re-checks each reply's author and digest and lets `needs-owner` stand only past the limit or the
 * rounds), rebuilds the waiting list from every owned summary and the bot's `needs-owner` answers,
 * updates the summary's verdict and waiting list (an edit of the bot's newest review, or a new
 * review when that one cannot be edited), the `needs-owner` label and the `MNG Review` status. It
 * posts no finding thread and no check run, and the summary's run count, head, finished flag and
 * unthreaded bugs stay as they were.
 */
export class ReplyPublishService extends Context.Service<
	ReplyPublishService,
	{
		readonly publish: (
			input: ReplyPublishInput
		) => Effect.Effect<ReplyPublishResult, SummaryWriteError, OwnedIdentities>
	}
>()('mng-review/ReplyPublishService') {}

export const ReplyPublishServiceLive = Layer.effect(
	ReplyPublishService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const config = yield* GitHubConfig
		const github = yield* GitHubStatusService
		const summaries = yield* SummaryReviewService
		const conversation = yield* ThreadReplyService
		const places = yield* ThreadPlaceService
		const replyChecks = yield* ReplyCheckService

		/**
		 * After a failed summary write: the status and the label from what the run computed, since the
		 * find step will not list the pull request again. A thread that waits sets `needs owner` and
		 * `failure`; with none the status stays.
		 */
		const failClosed = Effect.fn('ReplyPublishService.failClosed')(function* (
			input: FailClosedInput
		) {
			if (input.after > 0)
				yield* github
					.setStatus({
						sha: input.head,
						...toCommitStatus('needs owner', input.openBugs, true),
					})
					.pipe(Effect.ignore)
			yield* conversation.syncLabel(input.pullNumber, input.before, input.after)
		})

		/** The pull request's review threads as GitHub returns them, and the bot's among them. */
		const readAll = Effect.fn('ReplyPublishService.readAll')(function* (
			pullNumber: number
		) {
			const { identities } = yield* OwnedIdentities
			const raw = yield* api.listReviewThreads(pullNumber)
			const threads = raw.flatMap(
				thread => toBotThread(thread, identities) ?? []
			)
			return { raw, threads }
		})

		const publish = Effect.fn('ReplyPublishService.publish')(function* (
			input: ReplyPublishInput
		) {
			const { pullNumber } = input
			const links = toBlobLinks(config, input)
			const first = yield* readAll(pullNumber)
			const found = first.threads
			const { current, identities } = yield* OwnedIdentities
			// A failed whole-thread read leaves the latest comments the read brought for this run.
			const sentBefore = yield* conversation
				.getSentToOwner(first.raw)
				.pipe(
					Effect.orElseSucceed(() => getOwnerAnswered(first.raw, identities))
				)
			// Every summary's list, hidden ones too, and every thread the bot sent to the owner.
			const waiting = [
				...new Set([
					...(yield* summaries.readWaiting(pullNumber)),
					...sentBefore,
				]),
			]
			// Publishing's own git read between the bound base and the head, never the outcome file.
			const change = input.replies.decisions.some(entry =>
				LIMITED_ACTIONS.has(entry.decision.action)
			)
				? yield* places.readChange(input.replies.base, input.head)
				: undefined
			const decisions = yield* replyChecks.check({
				decisions: input.replies.decisions,
				threads: found,
				head: input.head,
				change,
			})
			const answered = yield* conversation.apply({
				links,
				decisions,
				threads: found,
				waiting,
				config: input.rules.config,
				change,
				...(input.run === undefined ? {} : { run: input.run }),
				...(input.held === undefined ? {} : { held: input.held }),
			})
			const closed = new Set(
				answered
					.filter(entry => CLOSING_ACTIONS.has(entry.decision.action))
					.map(entry => entry.thread.id)
			)
			const unsettled = yield* conversation.settle(first.raw, answered)
			// The answers are posted, so a failed read keeps the first one, but the run clears nothing.
			const second = yield* readAll(pullNumber).pipe(
				Effect.map(read => ({ ...read, reread: true })),
				Effect.orElseSucceed(() => ({ ...first, reread: false }))
			)
			// A dispatched reply in a resolved thread is answered as if open; unless it closed it, it is.
			const reopened = answered.filter(
				entry =>
					entry.thread.resolved && !CLOSING_ACTIONS.has(entry.decision.action)
			)
			const reopenedIds = new Set(reopened.map(entry => entry.thread.id))
			const latest = second.threads.map(thread => {
				if (closed.has(thread.id)) return { ...thread, resolved: true }
				return reopenedIds.has(thread.id)
					? { ...thread, resolved: false, closedByBot: false }
					: thread
			})
			// Answers this run or one alongside it sent to the owner wait, even if the summary write failed.
			const all = [
				...new Set([
					...waiting,
					...answered
						.filter(entry => entry.decision.action === 'needs-owner')
						.map(entry => entry.thread.id),
					...getOwnerAnswered(second.raw, identities),
				]),
			]
			const cleared = yield* conversation.getCleared({
				waiting: all,
				resolvers: toFreshResolvers(second, answered),
				threads: second.raw,
				allow: input.rules.config.commands.allow,
			})
			const update = { added: all.filter(id => !cleared.has(id)), cleared }
			const threadBugs = (yield* conversation.resolveUnsettled(
				latest,
				second.raw
			)).filter(isOpenBug).length
			// The head is read again, as a push run does; a failed read keeps the state.
			const pr = yield* api
				.getPullRequest(pullNumber)
				.pipe(Effect.orElseSucceed(() => undefined))
			const authored = pr?.user?.login.toLowerCase() === current.restLogin
			const written = yield* summaries
				.write(pullNumber, {
					head: input.head,
					render: prior => {
						const marker = toRepliedMarker(prior?.marker, update)
						const judged = toStanding(marker, input.head, threadBugs)
						const body = formatRepliedSummary(prior, {
							...judged,
							waiting: latest.filter(thread =>
								marker.needsOwner?.includes(thread.id)
							),
							marker,
							links,
						})
						const onCurrent = pr?.head.sha === input.head
						const evidence = {
							kind: 'reply',
							verdict: judged.verdict,
							openBugs: judged.openBugs,
							current: onCurrent,
							onHead: onCurrent && marker.head === input.head,
							failed: marker.failed === true || !second.reread,
							authored,
						} as const
						return { body, marker, evidence }
					},
				})
				.pipe(
					Effect.tapError(() =>
						failClosed({
							pullNumber,
							head: input.head,
							openBugs: threadBugs,
							before: waiting.length,
							after: update.added.length,
						})
					)
				)
			const standing = toStanding(written.marker, input.head, threadBugs)
			const owner = written.marker.needsOwner?.length ?? 0
			const status = yield* github
				.setStatus({
					sha: input.head,
					...toCommitStatus(
						standing.verdict,
						standing.openBugs,
						standing.finished
					),
				})
				.pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false)
				)
			const label = yield* conversation.syncLabel(
				pullNumber,
				waiting.length,
				owner
			)
			// Only a bug validation confirmed raises, as in the thread read.
			const reopenedBugs = reopened
				.filter(
					entry =>
						entry.thread.marker.kind === 'bug' &&
						entry.thread.marker.confirmed === true
				)
				.map(entry => entry.thread.marker.severity)
			return {
				...(reopenedBugs.length > 0 ? { reopened: reopenedBugs } : {}),
				verdict: standing.verdict,
				event: written.event,
				dismissal: written.dismissal,
				outlived: written.outlived,
				openBugs: standing.openBugs,
				answered: toAnswerCounts(answered),
				waiting: owner,
				label,
				run: written.marker.runs,
				status,
				unsettled: unsettled.size,
			} satisfies ReplyPublishResult
		})

		return { publish }
	})
).pipe(
	Layer.provide(
		Layer.mergeAll(
			ThreadReplyServiceLive,
			ThreadPlaceServiceLive,
			ReplyCheckServiceLive
		)
	)
)
