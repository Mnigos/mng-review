import type { Rules } from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import type { ReviewEvent } from '../../../platform/github-review.service'
import { GitHubStatusService } from '../../../platform/github-status.service'
import { GitHubConfig } from '../../../platform/github.config'
import { isReadIncomplete } from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	StatusReportService,
	StatusReportServiceLive,
} from '../../status/application/status-report.service'
import { toCommitStatus } from '../../status/domain/status.helper'
import {
	getOwnerAnswered,
	getOwnerWaiting,
	isOpenBug,
	type ReplyStanding,
	toReplyStanding,
} from '../domain/bot-thread.helper'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import { CLOSING_ACTIONS, LIMITED_ACTIONS } from '../domain/publish.constants'
import type {
	AnswerCounts,
	DismissalOutcome,
	LabelOutcome,
	OwnerWaits,
} from '../domain/publish.types'
import {
	toJudgedMarker,
	toRepliedMarker,
	toStoredWaits,
} from '../domain/summary-marker.helper'
import {
	toAnswerCounts,
	toFreshResolvers,
} from '../domain/thread-conversation.helper'
import type { Verdict } from '../presentation/summary-comment.formatter'
import { formatRepliedSummary } from '../presentation/summary-reply.formatter'
import { toBlobLinks } from '../presentation/thread-comment.formatter'
import {
	PublishReadService,
	PublishReadServiceLive,
} from './publish-read.service'
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
	/** Threads that wait for the owner after the run, those it held for itself only included. */
	readonly waiting: number
	readonly label: LabelOutcome
	/** The run count, unchanged. */
	readonly run: number
	/** Whether the `MNG Review` status was set. */
	readonly status: boolean
	/** Threads whose newest app answer is still unsettled after the run; any fails the job. */
	readonly unsettled: number
	/** A list read of the run left a null node out, so it cleared no wait and lifted no change request. */
	readonly incomplete?: true
}

/** What a reply-only run whose summary write failed still writes: the status and the label. */
interface FailClosedInput {
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
	 * What the summary's newest render judged or, when the write failed before rendering, what it
	 * would judge from the newest summary's marker; unset when that read failed too.
	 */
	readonly standing?: ReplyStanding
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
 * unthreaded bugs stay as they were. Threads a failed whole-thread read left unknown wait for this
 * run only, as at publishing: they set its verdict and status but are never stored. Once a list
 * read of the run, the summary write's own included, left a node out, no wait is cleared and the
 * label stays.
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
		const reads = yield* PublishReadService
		const statuses = yield* StatusReportService
		const config = yield* GitHubConfig
		const github = yield* GitHubStatusService
		const summaries = yield* SummaryReviewService
		const conversation = yield* ThreadReplyService
		const places = yield* ThreadPlaceService
		const replyChecks = yield* ReplyCheckService

		/**
		 * After a failed summary write: the status and the label from what the run computed, since the
		 * find step will not list the pull request again. A thread that waits sets `needs owner` and
		 * `failure`; with none the status stays. A run whose list reads left a node out writes the
		 * status of the standing its newest render judged instead, as the success path does, so an
		 * open bug it saw sets `failure` and a `success` becomes `pending` (`setVerdictStatus`); with
		 * no standing, that of its waits and thread bugs.
		 */
		const failClosed = Effect.fn('ReplyPublishService.failClosed')(function* (
			input: FailClosedInput
		) {
			const waits = input.after + input.held
			const standing = input.standing ?? {
				verdict: waits > 0 ? 'needs owner' : 'ready',
				openBugs: input.openBugs,
				finished: true,
			}
			if (input.incomplete)
				yield* statuses.setVerdictStatus(
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

		const publish = Effect.fn('ReplyPublishService.publish')(function* (
			input: ReplyPublishInput
		) {
			const { pullNumber } = input
			const links = toBlobLinks(config, input)
			const first = yield* reads.readAll(pullNumber)
			const found = first.threads
			const { current, identities } = yield* OwnedIdentities
			// A failed whole-thread read holds every longer owner thread for this run only.
			const waits = yield* conversation.getSentToOwner(first.raw).pipe(
				Effect.map((sent): OwnerWaits => ({ sent, held: [] })),
				Effect.orElseSucceed(() => getOwnerWaiting(first.raw, identities))
			)
			// Every summary's list, hidden ones too, and every thread the bot sent to the owner.
			const stored = [
				...new Set([
					...(yield* summaries.readWaiting(pullNumber)),
					...waits.sent,
				]),
			]
			const waiting = [...new Set([...stored, ...waits.held])]
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
			// A failed reread keeps the first read and this run's closes; non-closing answers reopen.
			const second = yield* reads.readAll(pullNumber).pipe(
				Effect.map(read => ({ ...read, reread: true })),
				Effect.orElseSucceed(() => ({ ...first, reread: false }))
			)
			const reopened = answered.filter(
				entry =>
					entry.thread.resolved && !CLOSING_ACTIONS.has(entry.decision.action)
			)
			const reopenedIds = new Set(reopened.map(entry => entry.thread.id))
			const latest = second.threads.map(thread => {
				if (!second.reread && closed.has(thread.id))
					return { ...thread, resolved: true }
				return reopenedIds.has(thread.id)
					? { ...thread, resolved: false, closedByBot: false }
					: thread
			})
			// Answers this run or one alongside it sent to the owner wait, even if the summary write failed.
			const all = [
				...new Set([
					...stored,
					...answered
						.filter(entry => entry.decision.action === 'needs-owner')
						.map(entry => entry.thread.id),
					...getOwnerAnswered(second.raw, identities),
				]),
			]
			const cleared = yield* conversation.getCleared({
				waiting: [...all, ...waits.held],
				resolvers: toFreshResolvers(second, answered),
				threads: second.raw,
				allow: input.rules.config.commands.allow,
			})
			// Held threads count in this run's verdict and status; the marker never stores them.
			const toWaits = (incomplete: boolean) =>
				toStoredWaits({ all, held: waits.held, cleared }, incomplete)
			const threadBugs = (yield* conversation.resolveUnsettled(
				latest,
				second.raw
			)).filter(isOpenBug).length
			// The head is read again, as a push run does; a failed read keeps the state.
			const pr = yield* api
				.getPullRequest(pullNumber)
				.pipe(Effect.orElseSucceed(() => undefined))
			const authored = pr?.user?.login.toLowerCase() === current.restLogin
			// What the render judges of the summary's marker, which a failed write sets the status from.
			const judge = (prior: SummaryMarker | undefined, incomplete: boolean) => {
				const { update, held } = toWaits(incomplete)
				const marker = toRepliedMarker(prior, update)
				const judging = toJudgedMarker(marker, held)
				return {
					marker,
					judging,
					standing: toReplyStanding(judging, input.head, threadBugs),
				}
			}
			const rendered: { standing?: ReplyStanding } = {}
			const written = yield* summaries
				.write(pullNumber, {
					head: input.head,
					render: (prior, _inline, _moved, incomplete) => {
						const {
							marker,
							judging,
							standing: judged,
						} = judge(prior?.marker, incomplete)
						rendered.standing = judged
						const body = formatRepliedSummary(prior, {
							...judged,
							waiting: latest.filter(thread =>
								judging.needsOwner?.includes(thread.id)
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
						Effect.gen(function* () {
							const incomplete = yield* isReadIncomplete
							const { update, held } = toWaits(incomplete)
							// Only an incomplete run sets the status from the standing (`failClosed`).
							const standing =
								rendered.standing ??
								(incomplete
									? yield* summaries.readPrior(pullNumber).pipe(
											Effect.map(prior => judge(prior, true).standing),
											Effect.orElseSucceed(() => undefined)
										)
									: undefined)
							yield* failClosed({
								pullNumber,
								head: input.head,
								openBugs: threadBugs,
								before: incomplete ? 0 : stored.length,
								after: update.added.length,
								held: held.length,
								incomplete,
								...(standing ? { standing } : {}),
							})
						})
					)
				)
			// A read that left a node out, the write's own included, cleared no wait.
			const incompleteRead = yield* isReadIncomplete
			const afterWrite = toWaits(incompleteRead)
			const judging = toJudgedMarker(written.marker, afterWrite.held)
			const standing = toReplyStanding(judging, input.head, threadBugs)
			const owner = judging.needsOwner?.length ?? 0
			const status = yield* statuses.setVerdictStatus(
				input.head,
				toCommitStatus(standing.verdict, standing.openBugs, standing.finished)
			)
			// The label outlives the run, so held threads never set it, and an incomplete run never
			// removes it: with no count before, it can only add it.
			const label = yield* conversation.syncLabel(
				pullNumber,
				incompleteRead ? 0 : stored.length,
				written.marker.needsOwner?.length ?? 0
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
				...(incompleteRead ? { incomplete: true } : {}),
			} satisfies ReplyPublishResult
		})

		return { publish }
	})
).pipe(
	Layer.provide(
		Layer.mergeAll(
			ThreadReplyServiceLive,
			ThreadPlaceServiceLive,
			ReplyCheckServiceLive,
			PublishReadServiceLive,
			StatusReportServiceLive
		)
	)
)
