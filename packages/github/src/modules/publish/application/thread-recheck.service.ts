import type { PullRequestInfo } from '@mng-review/domain'
import {
	GitService,
	RecheckService,
	type Rules,
	type TokensByModel,
} from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
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

/** What the re-check needs: the pull request, its head, the rules, the bot's threads and this run's findings. */
export interface ThreadRecheckInput {
	/** Shifts which candidates this run checks when there are more than `MAX_RECHECKS`: the run count. */
	readonly rotation: number
	readonly pr: PullRequestInfo
	readonly rules: Rules
	readonly head: string
	/** The bot's threads, read before the check. */
	readonly threads: readonly BotThread[]
	readonly published: readonly PublishedFinding[]
}

/** What the re-check found; nothing is written yet. */
export interface ThreadRecheckProposals {
	/** Threads the validator checked again. */
	readonly checked: number
	/** Threads whose finding the validator rejected at the head, with its reason. */
	readonly rejected: readonly ResolvedThread[]
	/** The job's tokens after the check, when it ran. */
	readonly tokens: TokensByModel | undefined
}

/**
 * Checks the bot's open threads again whose file changed since their commit, with the validator
 * over the change from that commit to the head, at most `MAX_RECHECKS` per run, a different batch
 * each run when there are more. Threads with a reply, nits, and findings this run found again are
 * left alone. It only proposes: the threads it rejects are resolved by publishing
 * (`ThreadResolutionService`), which checks them again in its own read. A git failure leaves a
 * thread out; the re-check never fails the run.
 */
export class ThreadRecheckService extends Context.Service<
	ThreadRecheckService,
	{
		readonly propose: (
			input: ThreadRecheckInput
		) => Effect.Effect<ThreadRecheckProposals>
	}
>()('mng-review/ThreadRecheckService') {}

export const ThreadRecheckServiceLive = Layer.effect(
	ThreadRecheckService,
	Effect.gen(function* () {
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

		const propose = Effect.fn('ThreadRecheckService.propose')(function* (
			input: ThreadRecheckInput
		) {
			const { head } = input
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
				return {
					checked: 0,
					rejected: [],
					tokens: undefined,
				} satisfies ThreadRecheckProposals
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
			return {
				checked: checked.length,
				rejected,
				tokens: report.tokens,
			} satisfies ThreadRecheckProposals
		})

		return { propose }
	})
)
