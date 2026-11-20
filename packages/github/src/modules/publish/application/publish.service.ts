import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { toCodeSpan } from '../../../utils/markdown.util'
import {
	getVerdict,
	isFinished,
	isFullReview,
	isRefused,
	toBotThread,
} from '../domain/bot-thread.helper'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import {
	countOpenBugs,
	countUnthreadedBugs,
	planPublish,
} from '../domain/publish-plan.helper'
import { SHORT_SHA_LENGTH } from '../domain/publish.constants'
import { PublishIncompleteError } from '../domain/publish.errors'
import type { BotThread, PlannedThread } from '../domain/publish.types'
import {
	getCarriedBugs,
	type MarkedRun,
	type MarkerUpdate,
	toNextSummaryMarker,
} from '../domain/summary-marker.helper'
import { toAnswerCounts } from '../domain/thread-conversation.helper'
import {
	formatSummaryComment,
	toSummaryWithMarker,
} from '../presentation/summary-comment.formatter'
import {
	formatThreadComment,
	toBlobLinks,
} from '../presentation/thread-comment.formatter'
import type { PublishInput, PublishResult } from './publish.service.types'
import { SummaryCommentService } from './summary-comment.service'
import {
	ThreadPlaceService,
	ThreadPlaceServiceLive,
} from './thread-place.service'
import {
	ThreadReplyService,
	ThreadReplyServiceLive,
} from './thread-reply.service'
import { ThreadResolutionService } from './thread-resolution.service'

/** Answers that close a thread for the bot's counts. */
const CLOSING_ACTIONS: ReadonlySet<string> = new Set(['resolved', 'accepted'])

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
 * after threads were posted fails with `PublishIncompleteError`. Before planning it applies the
 * re-check's proposals and the review's reply decisions (`ThreadReplyService`), so a thread they
 * close counts as resolved.
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

		const readThreads = Effect.fn('PublishService.readThreads')(function* (
			pullNumber: number
		) {
			const { identities } = yield* OwnedIdentities
			return (yield* api.listReviewThreads(pullNumber)).flatMap(
				thread => toBotThread(thread, identities) ?? []
			)
		})

		/** One thread through its fallbacks, line, file, summary; only a 422 moves it on. */
		const postSingle = Effect.fn('PublishService.postSingle')(function* (
			input: PublishInput,
			thread: PlannedThread
		) {
			const links = toBlobLinks(config, input)
			const post = (onLine: boolean) =>
				api.createReviewComment(input.pullNumber, {
					commitId: input.head,
					path: thread.finding.path,
					...(onLine ? { line: thread.finding.line } : {}),
					body: formatThreadComment(thread, links, onLine),
				})
			const toPlace = (place: PlannedThread['place']): PlannedThread => ({
				...thread,
				place,
			})
			const onFile = post(false).pipe(
				Effect.as(toPlace('file')),
				Effect.catch(error =>
					Effect.succeed(toPlace(isRefused(error) ? 'summary' : 'unposted'))
				)
			)
			if (thread.place !== 'line') return yield* onFile
			return yield* post(true).pipe(
				Effect.as(toPlace('line')),
				Effect.catch(error =>
					isRefused(error) ? onFile : Effect.succeed(toPlace('unposted'))
				)
			)
		})

		/**
		 * Posts the inline threads in one `COMMENT` review. When GitHub refuses it (a line it does
		 * not accept), each thread goes through its fallbacks alone, one at a time, since GitHub
		 * limits how fast content is created; after any other failure the review may exist, so the
		 * threads stay unposted. File comments follow.
		 */
		const postThreads = Effect.fn('PublishService.postThreads')(function* (
			input: PublishInput,
			threads: readonly PlannedThread[]
		) {
			const links = toBlobLinks(config, input)
			const onLine = threads.filter(thread => thread.place === 'line')
			const rest = threads.filter(thread => thread.place !== 'line')
			const review =
				onLine.length === 0
					? 'posted'
					: yield* api
							.createReview(input.pullNumber, {
								commitId: input.head,
								body: `MNG Review: ${onLine.length} new comment(s) on ${toCodeSpan(input.head.slice(0, SHORT_SHA_LENGTH))}. The summary is in the conversation.`,
								comments: onLine.map(thread => ({
									path: thread.finding.path,
									line: thread.finding.line,
									body: formatThreadComment(thread, links, true),
								})),
							})
							.pipe(
								Effect.as('posted' as const),
								Effect.catch(error =>
									Effect.succeed(isRefused(error) ? 'refused' : 'unknown')
								)
							)
			const lineResults =
				review === 'refused'
					? yield* Effect.forEach(onLine, thread => postSingle(input, thread), {
							concurrency: 1,
						})
					: onLine.map(thread =>
							review === 'posted'
								? thread
								: { ...thread, place: 'unposted' as const }
						)
			const restResults = yield* Effect.forEach(
				rest,
				thread =>
					thread.place === 'file'
						? postSingle(input, thread)
						: Effect.succeed(thread),
				{ concurrency: 1 }
			)
			return [...lineResults, ...restResults]
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
			const found = yield* readThreads(pullNumber)
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
			const answered = yield* conversation.apply({
				links,
				decisions: input.replies?.decisions ?? [],
				threads: found,
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
			const changedPlaces = yield* places.getChangedPlaces(input, threads)
			const planned = planPublish(
				{ outcome: report, config: input.rules.config, agents },
				{ threads, lines, changedPlaces }
			)
			const posted = yield* postThreads(input, planned.threads)
			const plan = { ...planned, threads: posted }
			// Read again: a run alongside this one may have posted or closed bug threads meanwhile.
			// The threads are posted, so a failed read keeps the first one.
			const latest = yield* readThreads(pullNumber).pipe(
				Effect.map(list =>
					list.map(thread =>
						resolvedIds.has(thread.id) ? { ...thread, resolved: true } : thread
					)
				),
				Effect.orElseSucceed(() => threads)
			)
			const threadBugs = countOpenBugs(plan, latest)
			const run = yield* checkRun(input)
			const update = {
				head: run.head,
				partial: run.partial,
				finished: isFinished(report),
				unthreadedBugs: countUnthreadedBugs(plan, latest),
			} satisfies MarkerUpdate
			const standing = (marker: SummaryMarker) => {
				const finished = isFullReview(report, marker, run)
				const openBugs = threadBugs + getCarriedBugs(marker, update)
				return {
					finished,
					openBugs,
					verdict: getVerdict(report, openBugs, finished),
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
						tokens:
							input.replies?.tokens ?? input.recheck?.tokens ?? report.tokens,
					})
					return { body, marker }
				})
				.pipe(Effect.mapError(error => new PublishIncompleteError({ error })))
			const { finished, openBugs, verdict } = standing(written.marker)
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
				run: written.marker.runs,
				finished,
				cleanup: written.cleanup,
			} satisfies PublishResult
		})

		return { publish, readThreads }
	})
).pipe(
	Layer.provide(Layer.mergeAll(ThreadPlaceServiceLive, ThreadReplyServiceLive))
)
