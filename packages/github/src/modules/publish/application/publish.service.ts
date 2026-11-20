import { GitService, type ReviewReport, SAFE_DIFF } from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { toCodeSpan } from '../../../utils/markdown.util'
import {
	getVerdict,
	isFinished,
	isRefused,
	toBotThread,
} from '../domain/bot-thread.helper'
import { createCommentableLinesFold } from '../domain/diff-hunk.parser'
import {
	countOpenBugs,
	countUnthreadedBugs,
	getMatchingThreads,
	getPublishedFindings,
	planPublish,
} from '../domain/publish-plan.helper'
import {
	SHORT_SHA_LENGTH,
	THREAD_PLACE_LINES,
} from '../domain/publish.constants'
import { PublishIncompleteError } from '../domain/publish.errors'
import type {
	BotThread,
	CommentableLines,
	PlannedThread,
} from '../domain/publish.types'
import { toNextSummaryMarker } from '../domain/summary-marker.helper'
import { formatSummaryComment } from '../presentation/summary-comment.formatter'
import {
	formatThreadComment,
	toBlobLinks,
} from '../presentation/thread-comment.formatter'
import type { PublishInput, PublishResult } from './publish.service.types'
import { SummaryCommentService } from './summary-comment.service'
import { ThreadResolutionService } from './thread-resolution.service'

/** Git reads that run at once when checking resolved threads. */
const GIT_CONCURRENCY = 4
/** Marks each commit line of `git log -L`, so commits are counted without parsing patches. */
const COMMIT_MARK = 'mng-review-commit:'

/**
 * Posts a run's findings on its pull request as the token's bot: one inline thread per new
 * finding, in one `COMMENT` review, a file comment when the line is outside the diff, and the
 * sticky summary through `SummaryCommentService`. A finding that already has an open thread of an
 * owned identity, or only resolved ones whose code did not change, is not posted again. A comment
 * the bot wrote but someone else edited no longer counts as the bot's. A summary write that fails
 * after threads were posted fails with `PublishIncompleteError`.
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
		const git = yield* GitService
		const config = yield* GitHubConfig
		const resolution = yield* ThreadResolutionService
		const summaries = yield* SummaryCommentService

		const readThreads = Effect.fn('PublishService.readThreads')(function* (
			pullNumber: number
		) {
			const { identities } = yield* OwnedIdentities
			return (yield* api.listReviewThreads(pullNumber)).flatMap(
				thread => toBotThread(thread, identities) ?? []
			)
		})

		/** Head lines of the diff that take an inline comment, and every changed file still there. */
		const readCommentableLines = Effect.fn(
			'PublishService.readCommentableLines'
		)(function* (report: ReviewReport, head: string) {
			const { change } = report.planReport
			const result = yield* git
				.foldLines(
					['diff', ...SAFE_DIFF, '-U3', change.mergeBase, head],
					createCommentableLinesFold()
				)
				.pipe(Effect.option)
			const lines = new Map<string, ReadonlySet<number>>(
				result._tag === 'Some' && result.value.exitCode === 0
					? result.value.state.lines
					: []
			)
			for (const file of change.files)
				if (file.status !== 'deleted' && !lines.has(file.path))
					lines.set(file.path, new Set())
			return lines satisfies CommentableLines
		})

		/**
		 * True when a commit since the thread's touched the finding's lines (`git log -L`, so an undone
		 * fix counts) or git cannot tell; false on the thread's own commit.
		 */
		const hasPlaceChanged = Effect.fn('PublishService.hasPlaceChanged')(
			function* (thread: BotThread, path: string, line: number, head: string) {
				if (!thread.commit) return true
				if (thread.commit === head) return false
				const text = yield* git.readFileAt(head, path).pipe(Effect.option)
				if (text._tag === 'None' || text.value === undefined) return true
				const lastLine = Math.max(
					1,
					text.value.replace(/\n$/u, '').split('\n').length
				)
				const start = Math.min(lastLine, Math.max(1, line - THREAD_PLACE_LINES))
				const end = Math.min(lastLine, line + THREAD_PLACE_LINES)
				const result = yield* git
					.exec([
						'log',
						'--no-ext-diff',
						'--no-textconv',
						'--no-color',
						`--format=${COMMIT_MARK}%H`,
						`-L${start},${end}:${path}`,
						`${thread.commit}..${head}`,
					])
					.pipe(Effect.option)
				if (result._tag === 'None' || result.value.exitCode !== 0) return true
				return result.value.stdout.includes(COMMIT_MARK)
			}
		)

		/** Ids of the resolved threads that cover a finding of this run and whose code changed. */
		const getChangedPlaces = Effect.fn('PublishService.getChangedPlaces')(
			function* (input: PublishInput, threads: readonly BotThread[]) {
				const published = getPublishedFindings({
					outcome: input.report,
					config: input.rules.config,
					agents: new Map(input.rules.agents.map(agent => [agent.name, agent])),
				})
				const checks = published.flatMap(entry =>
					getMatchingThreads(entry, threads)
						.filter(thread => thread.resolved)
						.map(thread => ({ thread, finding: entry.finding }))
				)
				const changed = yield* Effect.filter(
					checks,
					check =>
						hasPlaceChanged(
							check.thread,
							check.finding.path,
							check.finding.line,
							input.head
						),
					{ concurrency: GIT_CONCURRENCY }
				)
				return new Set(changed.map(check => check.thread.id))
			}
		)

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
			const resolvedIds = new Set(resolved.map(entry => entry.thread.id))
			const threads = found.map(thread =>
				resolvedIds.has(thread.id) ? { ...thread, resolved: true } : thread
			)
			const lines = yield* readCommentableLines(report, input.head)
			const changedPlaces = yield* getChangedPlaces(input, threads)
			const planned = planPublish(
				{ outcome: report, config: input.rules.config, agents },
				{ threads, lines, changedPlaces }
			)
			const posted = yield* postThreads(input, planned.threads)
			const plan = { ...planned, threads: posted }
			const openBugs = countOpenBugs(plan, threads)
			const verdict = getVerdict(report, openBugs)
			const written = yield* summaries
				.write(pullNumber, current => {
					const marker = toNextSummaryMarker(current?.marker, {
						head: input.head,
						finished: isFinished(report),
						unthreadedBugs: countUnthreadedBugs(plan),
					})
					const body = formatSummaryComment({
						report,
						plan,
						verdict,
						openBugs,
						marker,
						maxRuns: input.rules.config.limits.max_runs_per_pr,
						links,
						resolved,
						tokens: input.recheck?.tokens ?? report.tokens,
					})
					return { body, marker }
				})
				.pipe(Effect.mapError(error => new PublishIncompleteError({ error })))
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
				run: written.marker.runs,
				cleanup: written.cleanup,
			} satisfies PublishResult
		})

		return { publish, readThreads }
	})
)
