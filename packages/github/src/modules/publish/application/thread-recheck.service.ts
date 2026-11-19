import type { PullRequestInfo } from '@mng-review/domain'
import {
	GitService,
	RecheckService,
	type Rules,
	type TokensByModel,
} from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { toBotThread } from '../domain/bot-thread.helper'
import { MAX_RECHECKS } from '../domain/publish.constants'
import type {
	BotThread,
	PublishedFinding,
	ResolvedThread,
} from '../domain/publish.types'
import {
	getRecheckCandidates,
	getRotated,
	toThreadFinding,
} from '../domain/thread-recheck.helper'
import {
	type BlobLinks,
	formatResolvedReply,
} from '../presentation/thread-comment.formatter'

/** What the re-check needs: the pull request, its head, the rules and this run's findings. */
export interface ThreadRecheckInput {
	readonly pullNumber: number
	/** Shifts which candidates this run checks when there are more than `MAX_RECHECKS`: the run count. */
	readonly rotation: number
	readonly pr: PullRequestInfo
	readonly rules: Rules
	readonly links: BlobLinks
	readonly threads: readonly BotThread[]
	readonly published: readonly PublishedFinding[]
}

/** What the re-check did. */
export interface ThreadRecheckResult {
	readonly resolved: readonly ResolvedThread[]
	/** Threads the validator checked again. */
	readonly checked: number
	/** The job's tokens after the check, when it ran. */
	readonly tokens: TokensByModel | undefined
}

/**
 * Checks the bot's open threads again whose file changed since their commit, with the validator
 * over the change from that commit to the head, at most `MAX_RECHECKS` per run, a different batch
 * each run when there are more. A thread whose
 * finding the validator rejects gets a one-line reply with the head and the reason and is
 * resolved. Threads with a reply, nits, and findings this run found again are left alone. A git
 * or GitHub failure leaves a thread open; the re-check never fails the run.
 */
export class ThreadRecheckService extends Context.Service<
	ThreadRecheckService,
	{
		readonly recheck: (
			input: ThreadRecheckInput
		) => Effect.Effect<ThreadRecheckResult>
	}
>()('mng-review/ThreadRecheckService') {}

export const ThreadRecheckServiceLive = Layer.effect(
	ThreadRecheckService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const git = yield* GitService
		const rechecker = yield* RecheckService

		/** True when git shows a change to the thread's file since its commit; false when it cannot tell. */
		const hasFileChanged = Effect.fn('ThreadRecheckService.hasFileChanged')(
			function* (thread: BotThread, head: string) {
				if (!thread.commit) return false
				const result = yield* git
					.exec([
						'diff',
						'--quiet',
						'--no-ext-diff',
						'--no-textconv',
						thread.commit,
						head,
						'--',
						thread.path,
					])
					.pipe(Effect.option)
				return result._tag === 'Some' && result.value.exitCode === 1
			}
		)

		/**
		 * The rejected threads that are still the bot's, open and without a reply now; the
		 * validator took a while, and a thread someone answered or edited meanwhile is left alone.
		 * A failed read keeps none.
		 */
		const getUnchanged = Effect.fn('ThreadRecheckService.getUnchanged')(
			function* (pullNumber: number, rejected: readonly ResolvedThread[]) {
				if (rejected.length === 0) return []
				const fresh = yield* api
					.listReviewThreads(pullNumber)
					.pipe(Effect.option)
				if (fresh._tag === 'None') return []
				const now = new Map(
					fresh.value.flatMap(thread => {
						const bot = toBotThread(thread)
						return bot ? [[bot.id, bot] as const] : []
					})
				)
				return rejected.filter(entry => {
					const current = now.get(entry.thread.id)
					return (
						current !== undefined && !current.resolved && current.replies === 0
					)
				})
			}
		)

		/** Replies with the reason, then resolves; a failed reply leaves the thread untouched. */
		const resolve = Effect.fn('ThreadRecheckService.resolve')(function* (
			resolved: ResolvedThread,
			links: BlobLinks
		) {
			return yield* api
				.replyToThread(
					resolved.thread.id,
					formatResolvedReply(resolved.reason, links)
				)
				.pipe(
					Effect.flatMap(() => api.resolveThread(resolved.thread.id)),
					Effect.as([resolved]),
					Effect.orElseSucceed(() => [])
				)
		})

		const recheck = Effect.fn('ThreadRecheckService.recheck')(function* (
			input: ThreadRecheckInput
		) {
			const { head } = input.links
			const candidates = yield* Effect.filter(
				getRecheckCandidates(input.threads, input.published, head),
				thread => hasFileChanged(thread, head),
				{ concurrency: 4 }
			)
			const checked = getRotated(candidates, input.rotation).slice(
				0,
				MAX_RECHECKS
			)
			if (checked.length === 0)
				return { resolved: [], checked: 0, tokens: undefined }
			const pairs = checked.map(thread => ({
				thread,
				item: { finding: toThreadFinding(thread), base: thread.commit ?? head },
			}))
			const report = yield* rechecker.recheck({
				rules: input.rules,
				headRef: head,
				pr: input.pr,
				items: pairs.map(pair => pair.item),
			})
			const rejected = report.results.flatMap(result => {
				const pair = pairs.find(entry => entry.item.finding === result.finding)
				return pair && result.validation.status === 'rejected'
					? [{ thread: pair.thread, reason: result.validation.reason }]
					: []
			})
			const unchanged = yield* getUnchanged(input.pullNumber, rejected)
			const resolved = yield* Effect.forEach(
				unchanged,
				entry => resolve(entry, input.links),
				{ concurrency: 1 }
			)
			return {
				resolved: resolved.flat(),
				checked: checked.length,
				tokens: report.tokens,
			}
		})

		return { recheck }
	})
)
