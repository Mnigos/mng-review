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
import { getCoverageGaps, hasFailedRuns } from '../domain/coverage-gap.helper'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import {
	countOpenBugs,
	countUnthreadedBugs,
	planPublish,
	toSummaryPlace,
} from '../domain/publish-plan.helper'
import { CLOSING_ACTIONS, LIMITED_ACTIONS } from '../domain/publish.constants'
import { PublishIncompleteError } from '../domain/publish.errors'
import type {
	BotThread,
	PlannedThread,
	PublishPlan,
} from '../domain/publish.types'
import { getApproval } from '../domain/review-event.helper'
import {
	getCarriedBugs,
	type MarkerUpdate,
	toAnsweredMarker,
	toNextSummaryMarker,
} from '../domain/summary-marker.helper'
import {
	toAnswerCounts,
	toFreshResolvers,
} from '../domain/thread-conversation.helper'
import {
	formatSummaryComment,
	toSummaryWithMarker,
} from '../presentation/summary-comment.formatter'
import {
	formatThreadComment,
	toBlobLinks,
} from '../presentation/thread-comment.formatter'
import type {
	CheckedRun,
	PublishInput,
	PublishResult,
} from './publish.service.types'
import { ReplyCheckService, ReplyCheckServiceLive } from './reply-check.service'
import { SummaryReviewService } from './summary-review.service'
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

/**
 * Posts a run's findings as the token's bot: a comment per finding whose line is outside the diff,
 * then one review whose body is the summary and whose comments are the new inline threads
 * (`SummaryReviewService`). A finding an owned identity's open thread covers, or only resolved
 * ones whose code did not change, is not posted again; a comment someone else edited is no longer
 * the bot's. A review that fails after file comments may have been posted fails with
 * `PublishIncompleteError`. First it applies the re-check's proposals and the reply decisions that
 * pass its own git check (`ReplyCheckService`, `ThreadReplyService`) and settles earlier
 * unsettled answers; it keeps the owner's waiting threads in the summary marker, drops those an
 * owner cleared, and adds or removes the `needs-owner` label.
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
		const summaries = yield* SummaryReviewService
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
		 * Whether the run stands for a full review of its head. A push can land while a run reviews,
		 * so the pull request is read again: one whose head moved meanwhile, or cannot be read, is
		 * partial, as is a command that named a single agent.
		 */
		const checkRun = Effect.fn('PublishService.checkRun')(function* (
			input: PublishInput
		) {
			const { current } = yield* OwnedIdentities
			const pr = yield* api
				.getPullRequest(input.pullNumber)
				.pipe(Effect.orElseSucceed(() => undefined))
			const moved = pr?.head.sha !== input.head
			return {
				head: input.head,
				partial: input.command?.agentOnly === true || moved,
				moved,
				authored: pr?.user?.login.toLowerCase() === current.restLogin,
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
			const { current, identities } = yield* OwnedIdentities
			const approval = getApproval(input.rules.config, current)
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
				...(input.run === undefined ? {} : { run: input.run }),
				...(input.held === undefined ? {} : { held: input.held }),
			})
			const resolvedIds = new Set([
				...resolved.map(entry => entry.thread.id),
				...answered
					.filter(entry => CLOSING_ACTIONS.has(entry.decision.action))
					.map(entry => entry.thread.id),
			])
			// An answer that keeps a thread open reopened it, so a failed second read counts it open.
			const answeredIds = new Set(answered.map(entry => entry.thread.id))
			const threads = found.map(thread =>
				resolvedIds.has(thread.id) || answeredIds.has(thread.id)
					? { ...thread, resolved: resolvedIds.has(thread.id) }
					: thread
			)
			const lines = yield* places.readCommentableLines(report, input.head)
			// A thread this run closed was judged at this head, so its finding is dismissed, not posted.
			const changedPlaces = yield* places.getChangedPlaces(
				input,
				threads.filter(thread => !resolvedIds.has(thread.id))
			)
			const draft = planPublish(
				{ outcome: report, config: input.rules.config, agents },
				{ threads, lines, changedPlaces }
			)
			const planned = yield* places.keepCheckedEdits(draft, input.head)
			const filed = yield* poster.postFiles(input, planned.threads)
			const onLine = filed.filter(thread => thread.place === 'line')
			const posting =
				onLine.length > 0 || filed.some(thread => thread.place === 'file')
			const unsettled = yield* conversation.settle(first.raw, answered)
			// Read again after the answers; a failed read keeps the first, unseen reopened threads too.
			const second = yield* readAll(pullNumber).pipe(
				Effect.map(read => ({ ...read, reread: true })),
				Effect.orElseSucceed(() => ({ ...first, reread: false }))
			)
			// A successful read decides (`toBotThread`); a failed one keeps the first with this run's.
			const latest = second.reread ? second.threads : threads
			// Every new bug counts from the plan; an unsettled resolved bug counts open too.
			const known = yield* conversation.resolveUnsettled(latest, second.raw)
			const threadBugs = countOpenBugs(planned, known)
			const run = yield* checkRun(input)
			// Publishing's own read of the bot's threads, after this run's answers and file threads.
			const [gap, ...more] = [
				...(second.reread ? [] : [{ kind: 'threads' } as const]),
				...getCoverageGaps(report, latest),
			]
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
			/** The plan with its line threads inline, or in the summary when GitHub refused them. */
			const toPlan = (inline: boolean): PublishPlan => ({
				...planned,
				threads: inline ? filed : filed.map(toSummaryPlace),
			})
			const toUpdate = (plan: PublishPlan, checked: CheckedRun = run) =>
				({
					head: checked.head,
					partial: checked.partial,
					finished: isFinished(report),
					failed: hasFailedRuns(report),
					unthreadedBugs: countUnthreadedBugs(plan, latest),
					waiting: { added: all.filter(id => !cleared.has(id)), cleared },
				}) satisfies MarkerUpdate
			const standing = (
				marker: SummaryMarker,
				update: MarkerUpdate,
				checked: CheckedRun = run
			) => {
				const finished = isFullReview(report, marker, checked)
				const openBugs = threadBugs + getCarriedBugs(marker, update)
				const owner = marker.needsOwner?.length ?? 0
				return {
					finished,
					openBugs,
					verdict: getVerdict(report, openBugs, finished, owner),
				}
			}
			const written = yield* summaries
				.write(pullNumber, {
					head: input.head,
					comments: onLine.map(thread => ({
						path: thread.finding.path,
						line: thread.finding.line,
						body: formatThreadComment(thread, links, true),
					})),
					fresh: posting,
					render: (prior, inline, moved) => {
						// A push after the head check: partial, so the marker keeps the previous head and flags.
						const checked = moved ? { ...run, partial: true, moved } : run
						const plan = toPlan(inline)
						const update = toUpdate(plan, checked)
						const marker = toNextSummaryMarker(prior?.marker, update)
						const judged = standing(marker, update, checked)
						const evidence = {
							kind: 'review',
							verdict: judged.verdict,
							openBugs: judged.openBugs,
							onHead: !checked.moved,
							full: input.command?.agentOnly !== true,
							failed: hasFailedRuns(report) || !second.reread,
							gap,
							more,
							approval,
							authored: run.authored,
						} as const
						// The summary describes the head; a run whose head moved and posts nothing only counts
						// itself and the commands it answered, never its rating of the old head.
						const kept = prior && checked.moved && !posting
						const rated = toAnsweredMarker(
							marker,
							kept ? { answers: input.answers ?? [] } : input
						)
						if (kept)
							return {
								body: toSummaryWithMarker(prior.body, rated),
								marker: rated,
								evidence,
								standing: judged,
							}
						const body = formatSummaryComment({
							report,
							...(input.rating ? { rating: input.rating } : {}),
							plan,
							...judged,
							carriedBugs: getCarriedBugs(marker, update),
							marker: rated,
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
						return { body, marker: rated, evidence, standing: judged }
					},
				})
				.pipe(Effect.mapError(error => new PublishIncompleteError({ error })))
			const plan = toPlan(written.inline)
			// The standing of the render the write used, which judged against the write's own head read.
			const { finished, openBugs, verdict } =
				written.standing ?? standing(written.marker, toUpdate(plan))
			const owner = written.marker.needsOwner?.length ?? 0
			const label = yield* conversation.syncLabel(
				pullNumber,
				waiting.length,
				owner
			)
			const count = (place: PlannedThread['place']) =>
				plan.threads.filter(thread => thread.place === place).length
			return {
				verdict,
				event: written.event,
				dismissal: written.dismissal,
				outlived: written.outlived,
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
				unsettled: unsettled.size,
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
