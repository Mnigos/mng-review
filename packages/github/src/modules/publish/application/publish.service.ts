import {
	GitService,
	type ReviewReport,
	type Rules,
	SAFE_DIFF,
} from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import type { GitHubApiError } from '../../../platform/github.errors'
import {
	getVerdict,
	isBotComment,
	isRefused,
	toBotThread,
} from '../domain/bot-thread.helper'
import { createCommentableLinesFold } from '../domain/diff-hunk.parser'
import { parseSummaryMarker } from '../domain/publish-marker.parser'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import {
	countOpenBugs,
	getMatchingThreads,
	getPublishedFindings,
	planPublish,
} from '../domain/publish-plan.helper'
import {
	MARKER_VERSION,
	SHORT_SHA_LENGTH,
	THREAD_PLACE_LINES,
} from '../domain/publish.constants'
import type {
	BotThread,
	CommentableLines,
	PlannedThread,
} from '../domain/publish.types'
import {
	formatStatusComment,
	formatSummaryComment,
	type Verdict,
} from '../presentation/summary-comment.formatter'
import {
	type BlobLinks,
	formatThreadComment,
} from '../presentation/thread-comment.formatter'

/** Git reads that run at once when checking resolved threads. */
const GIT_CONCURRENCY = 4
const NOT_FOUND_STATUS = 404
/** Marks each commit line of `git log -L`, so commits are counted without parsing patches. */
const COMMIT_MARK = 'mng-review-commit:'

/** The pull request and commits a publish call is about. */
export interface PublishTarget {
	readonly pullNumber: number
	/** The reviewed head commit; threads are posted on it. */
	readonly head: string
	readonly engineCommit: string | undefined
}

/** A reviewed run to publish on its pull request. */
export interface PublishInput extends PublishTarget {
	readonly report: ReviewReport
	readonly rules: Pick<Rules, 'config' | 'agents'>
}

/** A run that did not review, shown in the sticky summary only when there is none yet. */
export interface StatusInput extends PublishTarget {
	readonly status: string
}

/** What a publish run did. */
export interface PublishResult {
	readonly verdict: Verdict
	readonly openBugs: number
	readonly onLine: number
	readonly onFile: number
	readonly inSummary: number
	/** Threads whose write failed with no answer or a server error; whether GitHub stored them is unknown. */
	readonly unposted: number
	readonly repeated: number
	readonly run: number
}

/**
 * Posts a run's findings on its pull request as the job token's bot: one inline thread per new
 * finding, in one `COMMENT` review, a file comment when the line is outside the diff, and the
 * sticky summary, edited in place. A finding that already has an open thread of the bot, or only
 * resolved ones whose code did not change, is not posted again. A comment the bot wrote but
 * someone else edited no longer counts as the bot's.
 */
export class PublishService extends Context.Service<
	PublishService,
	{
		readonly publish: (
			input: PublishInput
		) => Effect.Effect<PublishResult, GitHubApiError>
		readonly publishStatus: (
			input: StatusInput
		) => Effect.Effect<void, GitHubApiError>
	}
>()('mng-review/PublishService') {}

export const PublishServiceLive = Layer.effect(
	PublishService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const git = yield* GitService
		const config = yield* GitHubConfig

		/** Links to the repository at the target's head. */
		const toLinks = (target: PublishTarget): BlobLinks => ({
			serverUrl: config.serverUrl,
			owner: config.owner,
			name: config.name,
			head: target.head,
			engineCommit: target.engineCommit,
		})

		/** The bot's sticky summary: its oldest unedited comment that ends with a summary marker. */
		const readSummary = Effect.fn('PublishService.readSummary')(function* (
			pullNumber: number
		) {
			const comments = yield* api.listComments(pullNumber)
			return comments.flatMap(comment => {
				if (comment.databaseId === null || !isBotComment(comment)) return []
				const marker = parseSummaryMarker(comment.body)
				return marker ? [{ id: comment.databaseId, marker }] : []
			})[0]
		})

		/** Edits the summary, or creates it when there is none or it was deleted since it was read. */
		const writeSummary = Effect.fn('PublishService.writeSummary')(function* (
			pullNumber: number,
			existing: number | undefined,
			body: string
		) {
			const create = api
				.createIssueComment(pullNumber, body)
				.pipe(Effect.asVoid)
			if (existing === undefined) return yield* create
			return yield* api.updateIssueComment(existing, body).pipe(
				Effect.catchIf(
					error => error.status === NOT_FOUND_STATUS,
					() => create
				)
			)
		})

		/**
		 * Head lines of the merge base..head diff that take an inline comment, and every changed
		 * file that still exists, which takes a file comment. No lines when git fails.
		 */
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
		 * True when a commit since the thread's touched the code around the finding at the head
		 * (`git log -L`, which follows the lines through every commit, so a fix that was undone
		 * counts), and when git cannot tell: a missing commit after a force-push, a missing file.
		 */
		const hasPlaceChanged = Effect.fn('PublishService.hasPlaceChanged')(
			function* (thread: BotThread, path: string, line: number, head: string) {
				if (!thread.commit) return true
				const text = yield* git.readFileAt(head, path).pipe(Effect.option)
				if (text._tag === 'None' || text.value === undefined) return true
				const lastLine = Math.max(1, text.value.split('\n').length)
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

		/**
		 * One thread through its fallbacks: its line, then its file, then the summary. Only a 422
		 * moves it on; any other failure leaves it unposted, since GitHub may have stored it.
		 */
		const postSingle = Effect.fn('PublishService.postSingle')(function* (
			input: PublishInput,
			thread: PlannedThread
		) {
			const links = toLinks(input)
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
			const links = toLinks(input)
			const onLine = threads.filter(thread => thread.place === 'line')
			const rest = threads.filter(thread => thread.place !== 'line')
			const review =
				onLine.length === 0
					? 'posted'
					: yield* api
							.createReview(input.pullNumber, {
								commitId: input.head,
								body: `MNG Review: ${onLine.length} new comment(s) on ${input.head.slice(0, SHORT_SHA_LENGTH)}. The summary is in the conversation.`,
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
					thread.place === 'summary'
						? Effect.succeed(thread)
						: postSingle(input, thread),
				{ concurrency: 1 }
			)
			return [...lineResults, ...restResults]
		})

		const publish = Effect.fn('PublishService.publish')(function* (
			input: PublishInput
		) {
			const { report, pullNumber } = input
			const links = toLinks(input)
			const threads = (yield* api.listReviewThreads(pullNumber)).flatMap(
				thread => toBotThread(thread) ?? []
			)
			const summary = yield* readSummary(pullNumber)
			const marker: SummaryMarker = {
				v: MARKER_VERSION,
				runs: (summary?.marker.runs ?? 0) + 1,
				head: input.head,
			}
			const lines = yield* readCommentableLines(report, input.head)
			const changedPlaces = yield* getChangedPlaces(input, threads)
			const planned = planPublish(
				{
					outcome: report,
					config: input.rules.config,
					agents: new Map(input.rules.agents.map(agent => [agent.name, agent])),
				},
				{ threads, lines, changedPlaces }
			)
			const posted = yield* postThreads(input, planned.threads)
			const plan = { ...planned, threads: posted }
			const openBugs = countOpenBugs(plan, threads)
			const verdict = getVerdict(report, openBugs)
			yield* writeSummary(
				pullNumber,
				summary?.id,
				formatSummaryComment({
					report,
					plan,
					verdict,
					openBugs,
					marker,
					maxRuns: input.rules.config.limits.max_runs_per_pr,
					links,
				})
			)
			const count = (place: PlannedThread['place']) =>
				posted.filter(thread => thread.place === place).length
			return {
				verdict,
				openBugs,
				onLine: count('line'),
				onFile: count('file'),
				inSummary: count('summary'),
				unposted: count('unposted'),
				repeated: plan.repeated.length,
				run: marker.runs,
			} satisfies PublishResult
		})

		const publishStatus = Effect.fn('PublishService.publishStatus')(function* (
			input: StatusInput
		) {
			const summary = yield* readSummary(input.pullNumber)
			if (summary) return
			yield* api.createIssueComment(
				input.pullNumber,
				formatStatusComment(
					input.status,
					{ v: MARKER_VERSION, runs: 0, head: input.head },
					toLinks(input)
				)
			)
		})

		return { publish, publishStatus }
	})
)
