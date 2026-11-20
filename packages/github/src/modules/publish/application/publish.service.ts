import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	getOwnerAnswered,
	getVerdict,
	isFinished,
	isFullReview,
	toBotThread,
} from '../domain/bot-thread.helper'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import {
	countOpenBugs,
	countUnthreadedBugs,
	planPublish,
} from '../domain/publish-plan.helper'
import { PublishIncompleteError } from '../domain/publish.errors'
import type { BotThread, PlannedThread } from '../domain/publish.types'
import {
	getCarriedBugs,
	type MarkedRun,
	type MarkerUpdate,
	toNextSummaryMarker,
} from '../domain/summary-marker.helper'
import {
	toAnswerCounts,
	toResolvers,
} from '../domain/thread-conversation.helper'
import {
	formatSummaryComment,
	toSummaryWithMarker,
} from '../presentation/summary-comment.formatter'
import { toBlobLinks } from '../presentation/thread-comment.formatter'
import type { PublishInput, PublishResult } from './publish.service.types'
import { ReplyCheckService, ReplyCheckServiceLive } from './reply-check.service'
import { SummaryCommentService } from './summary-comment.service'
import {
	ThreadPlaceService,
	ThreadPlaceServiceLive,
} from './thread-place.service'
import { ThreadPostService, ThreadPostServiceLive } from './thread-post.service'
import {
	ThreadReplyService,
	ThreadReplyServiceLive,
} from './thread-reply.service'
import { ThreadResolutionService } from './thread-resolution.service'

/** Answers that close a thread for the bot's counts; publishing checks them against git first. */
const CLOSING_ACTIONS: ReadonlySet<string> = new Set(['resolved', 'accepted'])
/** Answers checked against the change read from git: the owner's limit, and an `accepted` one's evidence. */
const LIMITED_ACTIONS: ReadonlySet<string> = new Set([
	'accepted',
	'needs-owner',
])

/** A run as the marker judges it, and whether its pull request moved to another head meanwhile. */
interface CheckedRun extends MarkedRun {
	readonly moved: boolean
}

/**
 * Posts a run's findings on its pull request as the token's bot: one inline thread per new
 * finding, in one `COMMENT` review, a file comment when the line is outside the diff, and the
 * sticky summary through `SummaryCommentService`. A finding that already has an open thread of an
 * owned identity, or only resolved ones whose code did not change, is not posted again. A comment
 * the bot wrote but someone else edited no longer counts as the bot's. A summary write that fails
 * after threads were posted fails with `PublishIncompleteError`. Threads go out through
 * `ThreadPostService`. Before planning it applies the
 * re-check's proposals and the review's reply decisions that pass its own git check
 * (`ReplyCheckService`, then `ThreadReplyService`), so a thread they close counts as resolved; it
 * keeps the threads that wait for the owner in the summary marker, drops those an owner cleared,
 * and adds or removes the `needs-owner` label.
 */
export class PublishService extends Context.Service<
	PublishService,
	{
		readonly publish: (
			input: PublishInput
		) => Effect.Effect<
			PublishResult,
			GitHubApiError | PublishIncompleteError,
			OwnedIdentities
		>
		/** The bot's review threads, found by an owned author and marker; comments someone else edited do not count. */
		readonly readThreads: (
			pullNumber: number
		) => Effect.Effect<readonly BotThread[], GitHubApiError, OwnedIdentities>
	}
>()('mng-review/PublishService') {}

export const PublishServiceLive = Layer.effect(
	PublishService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const config = yield* GitHubConfig
		const resolution = yield* ThreadResolutionService
		const summaries = yield* SummaryCommentService
		const places = yield* ThreadPlaceService
		const conversation = yield* ThreadReplyService
		const replyChecks = yield* ReplyCheckService
		const poster = yield* ThreadPostService

		/** The pull request's review threads as GitHub returns them, and the bot's among them. */
		const readAll = Effect.fn('PublishService.readAll')(function* (
			pullNumber: number
		) {
			const { identities } = yield* OwnedIdentities
			const raw = yield* api.listReviewThreads(pullNumber)
			const threads = raw.flatMap(
				thread => toBotThread(thread, identities) ?? []
			)
			return { raw, threads }
		})

		const readThreads = Effect.fn('PublishService.readThreads')(function* (
			pullNumber: number
		) {
			return (yield* readAll(pullNumber)).threads
		})

		/**
		 * Whether the run stands for a full review of its head. A command overlaps push runs, so its
		 * pull request is read again: one whose head moved meanwhile, or cannot be read, is partial,
		 * as is one that named a single agent. A push run is the head's own run.
		 */
		const checkRun = Effect.fn('PublishService.checkRun')(function* (
			input: PublishInput
		) {
			if (!input.command)
				return {
					head: input.head,
					partial: false,
					moved: false,
				} satisfies CheckedRun
			const head = yield* api.getPullRequest(input.pullNumber).pipe(
				Effect.map(pr => pr.head.sha),
				Effect.orElseSucceed(() => undefined)
			)
			const moved = head !== input.head
			return {
				head: input.head,
				partial: input.command.agentOnly || moved,
				moved,
			} satisfies CheckedRun
		})

		const publish = Effect.fn('PublishService.publish')(function* (
			input: PublishInput
		) {
			const { report, pullNumber } = input
			const links = toBlobLinks(config, input)
			const first = yield* readAll(pullNumber)
			const found = first.threads
			const agents = new Map(
				input.rules.agents.map(agent => [agent.name, agent])
			)
			const resolved = input.recheck
				? yield* resolution.apply({
						links,
						proposals: input.recheck.proposals,
						threads: found,
					})
				: []
			const { identities } = yield* OwnedIdentities
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
			const { replies } = input
			const change = replies?.decisions.some(entry =>
				LIMITED_ACTIONS.has(entry.decision.action)
			)
				? yield* places.readChange(replies.base, input.head)
				: undefined
			const decisions = replies
				? yield* replyChecks.check({
						decisions: replies.decisions,
						threads: found,
						head: input.head,
						change,
					})
				: []
			const answered = yield* conversation.apply({
				links,
				decisions,
				threads: found,
				waiting,
				config: input.rules.config,
				change,
			})
			const resolvedIds = new Set([
				...resolved.map(entry => entry.thread.id),
				...answered
					.filter(entry => CLOSING_ACTIONS.has(entry.decision.action))
					.map(entry => entry.thread.id),
			])
			const threads = found.map(thread =>
				resolvedIds.has(thread.id) ? { ...thread, resolved: true } : thread
			)
			const lines = yield* places.readCommentableLines(report, input.head)
			// A thread this run closed was judged at this head, so its finding is dismissed, not posted.
			const changedPlaces = yield* places.getChangedPlaces(
				input,
				threads.filter(thread => !resolvedIds.has(thread.id))
			)
			const planned = planPublish(
				{ outcome: report, config: input.rules.config, agents },
				{ threads, lines, changedPlaces }
			)
			const posted = yield* poster.postThreads(input, planned.threads)
			const plan = { ...planned, threads: posted }
			// Read again: a run alongside this one may have posted or closed bug threads meanwhile.
			// The threads are posted, so a failed read keeps the first one.
			const second = yield* readAll(pullNumber).pipe(
				Effect.orElseSucceed(() => first)
			)
			const latest = second.threads.map(thread =>
				resolvedIds.has(thread.id) ? { ...thread, resolved: true } : thread
			)
			const threadBugs = countOpenBugs(plan, latest)
			const run = yield* checkRun(input)
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
				resolvers: toResolvers(second.raw),
				allow: input.rules.config.commands.allow,
			})
			const update = {
				head: run.head,
				partial: run.partial,
				finished: isFinished(report),
				unthreadedBugs: countUnthreadedBugs(plan, latest),
				waiting: { added: all.filter(id => !cleared.has(id)), cleared },
			} satisfies MarkerUpdate
			const standing = (marker: SummaryMarker) => {
				const finished = isFullReview(report, marker, run)
				const openBugs = threadBugs + getCarriedBugs(marker, update)
				const owner = marker.needsOwner?.length ?? 0
				return {
					finished,
					openBugs,
					verdict: getVerdict(report, openBugs, finished, owner),
				}
			}
			const written = yield* summaries
				.write(pullNumber, current => {
					const marker = toNextSummaryMarker(current?.marker, update)
					// The summary describes the head; a run whose head moved only counts itself.
					if (current && run.moved)
						return { body: toSummaryWithMarker(current.body, marker), marker }
					const body = formatSummaryComment({
						report,
						plan,
						...standing(marker),
						carriedBugs: getCarriedBugs(marker, update),
						marker,
						maxRuns: input.rules.config.limits.max_runs_per_pr,
						links,
						resolved,
						answered,
						waiting: latest.filter(thread =>
							marker.needsOwner?.includes(thread.id)
						),
						tokens:
							input.replies?.tokens ?? input.recheck?.tokens ?? report.tokens,
					})
					return { body, marker }
				})
				.pipe(Effect.mapError(error => new PublishIncompleteError({ error })))
			const { finished, openBugs, verdict } = standing(written.marker)
			const owner = written.marker.needsOwner?.length ?? 0
			const label = yield* conversation.syncLabel(
				pullNumber,
				waiting.length,
				owner
			)
			const count = (place: PlannedThread['place']) =>
				posted.filter(thread => thread.place === place).length
			return {
				verdict,
				openBugs,
				onLine: count('line'),
				onFile: count('file'),
				inSummary: count('summary') + count('pull_request'),
				unposted: count('unposted'),
				repeated: plan.repeated.length,
				dismissed: plan.dismissed.length,
				rechecked: input.recheck?.checked ?? 0,
				resolved: resolved.length,
				answered: toAnswerCounts(answered),
				waiting: owner,
				label,
				run: written.marker.runs,
				finished,
				cleanup: written.cleanup,
			} satisfies PublishResult
		})

		return { publish, readThreads }
	})
).pipe(
	Layer.provide(
		Layer.mergeAll(
			ThreadPlaceServiceLive,
			ThreadReplyServiceLive,
			ReplyCheckServiceLive,
			ThreadPostServiceLive
		)
	)
)
