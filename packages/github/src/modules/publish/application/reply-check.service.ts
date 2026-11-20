import {
	type Change,
	commitShaSchema,
	normalizeRepoPath,
} from '@mng-review/domain'
import {
	GitService,
	ReplyEvidenceService,
	ReplyEvidenceServiceLive,
} from '@mng-review/engine'
import { Context, Effect, Layer, Schema } from 'effect'
import type { BotThread } from '../domain/publish.types'
import type { DecidedThreadReply } from '../domain/thread-reply.schema'

const isCommitSha = Schema.is(commitShaSchema)

/** The review's reply decisions and what publishing read itself. */
export interface ReplyCheckInput {
	readonly decisions: readonly DecidedThreadReply[]
	/** The bot's threads as publishing read them. */
	readonly threads: readonly BotThread[]
	/** The bound head commit. */
	readonly head: string
	/**
	 * The change between the bound commits as publishing read it from git; `undefined` when that
	 * failed or no decision is `accepted`.
	 */
	readonly change: Change | undefined
}

/**
 * Publishing's own git check of the decisions that close a thread, since the outcome file is the
 * review job's, which runs model code and could forge one. Every git failure drops the decision.
 */
export class ReplyCheckService extends Context.Service<
	ReplyCheckService,
	{
		/**
		 * The decisions that still stand. `resolved` stands when the thread's commit is an ancestor of
		 * the bound head and a commit after it touched the finding's file (a rename of it counts), as
		 * the engine's `fixed` gate asks. `accepted` stands when an evidence entry passes
		 * `ReplyEvidenceService.checkInCode` at the bound commits and keeps only the entries that
		 * pass. Other actions pass unchanged.
		 */
		readonly check: (
			input: ReplyCheckInput
		) => Effect.Effect<readonly DecidedThreadReply[]>
	}
>()('mng-review/ReplyCheckService') {}

export const ReplyCheckServiceLive = Layer.effect(
	ReplyCheckService,
	Effect.gen(function* () {
		const git = yield* GitService
		const evidence = yield* ReplyEvidenceService

		/** True when `git` exits 0 with output that is more than blank. */
		const hasOutput = (args: readonly string[]) =>
			git.exec(args).pipe(
				Effect.map(
					result => result.exitCode === 0 && result.stdout.trim() !== ''
				),
				Effect.orElseSucceed(() => false)
			)

		/** True when the thread's commit is an ancestor of `head` and a commit since touched its file. */
		const hasCommitSince = Effect.fn('ReplyCheckService.hasCommitSince')(
			function* (thread: BotThread, head: string) {
				const since = thread.commit
				if (
					since === undefined ||
					!isCommitSha(since) ||
					normalizeRepoPath(thread.path) !== thread.path
				)
					return false
				const ancestry = yield* git
					.exec([
						'merge-base',
						'--is-ancestor',
						'--end-of-options',
						since,
						head,
					])
					.pipe(Effect.orElseSucceed(() => undefined))
				if (ancestry?.exitCode !== 0) return false
				return yield* hasOutput([
					'log',
					'--full-history',
					'--format=%H',
					'-n',
					'1',
					'--end-of-options',
					`${since}..${head}`,
					'--',
					thread.path,
				])
			}
		)

		/** The decision as it stands after publishing's check, or none. */
		const checkDecision = Effect.fn('ReplyCheckService.checkDecision')(
			function* (decided: DecidedThreadReply, input: ReplyCheckInput) {
				const { decision } = decided
				if (decision.action !== 'resolved' && decision.action !== 'accepted')
					return [decided]
				const thread = input.threads.find(
					entry => entry.id === decided.threadId
				)
				if (!thread) return []
				if (decision.action === 'resolved')
					return (yield* hasCommitSince(thread, input.head)) ? [decided] : []
				const { change } = input
				if (!change) return []
				const passed = yield* evidence
					.checkInCode(decision.evidence, change)
					.pipe(Effect.orElseSucceed((): readonly string[] => []))
				if (passed.length === 0) return []
				return [{ ...decided, decision: { ...decision, evidence: passed } }]
			}
		)

		const check = Effect.fn('ReplyCheckService.check')(function* (
			input: ReplyCheckInput
		) {
			const checked = yield* Effect.forEach(
				input.decisions,
				decided => checkDecision(decided, input),
				{ concurrency: 1 }
			)
			return checked.flat()
		})

		return { check }
	})
).pipe(Layer.provide(ReplyEvidenceServiceLive))
