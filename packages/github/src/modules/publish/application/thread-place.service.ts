import type { Change } from '@mng-review/domain'
import { GitService, type ReviewReport, SAFE_DIFF } from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { createCommentableLinesFold } from '../domain/diff-hunk.parser'
import {
	getMatchingThreads,
	getPublishedFindings,
} from '../domain/publish-plan.helper'
import { THREAD_PLACE_LINES } from '../domain/publish.constants'
import type { BotThread, CommentableLines } from '../domain/publish.types'
import type { PublishInput } from './publish.service.types'

/** Git reads that run at once when checking resolved threads. */
const GIT_CONCURRENCY = 4
/** Marks each commit line of `git log -L`, so commits are counted without parsing patches. */
const COMMIT_MARK = 'mng-review-commit:'

/** The run whose findings are matched against resolved threads. */
export type PlaceInput = Pick<PublishInput, 'report' | 'rules' | 'head'>

/**
 * What git says about places in the pull request: the head lines that take an inline comment,
 * which resolved threads had their code changed since, so a finding found again under them is
 * posted again instead of dismissed, and the change's files between two commits.
 */
export class ThreadPlaceService extends Context.Service<
	ThreadPlaceService,
	{
		readonly readCommentableLines: (
			report: ReviewReport,
			head: string
		) => Effect.Effect<CommentableLines>
		readonly getChangedPlaces: (
			input: PlaceInput,
			threads: readonly BotThread[]
		) => Effect.Effect<ReadonlySet<string>>
		/**
		 * The change between the merge base of `base` and `head` (its commits, files and renames) as
		 * git reads it; `undefined` when git fails. Never from the outcome file, which the review job
		 * shapes.
		 */
		readonly readChange: (
			base: string,
			head: string
		) => Effect.Effect<Change | undefined>
	}
>()('mng-review/ThreadPlaceService') {}

export const ThreadPlaceServiceLive = Layer.effect(
	ThreadPlaceService,
	Effect.gen(function* () {
		const git = yield* GitService

		/** Head lines of the diff that take an inline comment, and every changed file still there. */
		const readCommentableLines = Effect.fn(
			'ThreadPlaceService.readCommentableLines'
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
		 * fix counts) or git cannot tell; false on that commit itself. A thread the bot's answer closed
		 * counts from the head that answer names (`closedAt`), so an accepted finding is not posted
		 * again for a change made before it was accepted.
		 */
		const hasPlaceChanged = Effect.fn('ThreadPlaceService.hasPlaceChanged')(
			function* (thread: BotThread, path: string, line: number, head: string) {
				const since = thread.closedAt ?? thread.commit
				if (!since) return true
				if (since === head) return false
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
						`${since}..${head}`,
					])
					.pipe(Effect.option)
				if (result._tag === 'None' || result.value.exitCode !== 0) return true
				return result.value.stdout.includes(COMMIT_MARK)
			}
		)

		/** Ids of the resolved threads that cover a finding of this run and whose code changed. */
		const getChangedPlaces = Effect.fn('ThreadPlaceService.getChangedPlaces')(
			function* (input: PlaceInput, threads: readonly BotThread[]) {
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

		const readChange = Effect.fn('ThreadPlaceService.readChange')(function* (
			base: string,
			head: string
		) {
			return yield* git
				.readChange(base, head)
				.pipe(Effect.orElseSucceed((): Change | undefined => undefined))
		})

		return { readCommentableLines, getChangedPlaces, readChange }
	})
)
