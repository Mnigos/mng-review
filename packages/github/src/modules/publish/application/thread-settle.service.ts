import { Context, Effect, Layer } from 'effect'
import { isOwnedBot } from '../../../platform/bot-identity.helper'
import type {
	ReviewThread,
	ThreadComment,
} from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import {
	isReadIncomplete,
	readListed,
} from '../../../platform/list-completeness.context'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	getUnsettledAnswer,
	getWindowUnsettled,
	isUnsettled,
} from '../domain/bot-thread.helper'
import type { BotThread } from '../domain/publish.types'
import { getOwnerCleared } from '../domain/thread-conversation.helper'
import { toSettledAnswer } from '../presentation/thread-reply.formatter'

/** The waiting threads and who resolved each resolved thread of a fresh read (`toResolvers`). */
export interface ClearedInput {
	readonly waiting: readonly string[]
	readonly resolvers: ReadonlyMap<string, string>
	/** The raw threads of the read the resolvers came from; a thread missing here clears nothing. */
	readonly threads: readonly ReviewThread[]
	/** `commands.allow` of the rules in force. */
	readonly allow: readonly string[]
}

/** The answer a settle edits: its `databaseId` and the body it was posted with. */
export type SettledAnswer = Pick<ThreadComment, 'databaseId' | 'body'>

/**
 * The app's unsettled answers. GitHub gives no resolution time, so an answer after which its thread
 * must be reopened is posted with `unsettled` in its reply marker, and only a reopen followed by an
 * edit that drops the flag settles it. Until then every reader counts the thread as open and no
 * resolution clears its wait, across runs and the sweep alike.
 */
export class ThreadSettleService extends Context.Service<
	ThreadSettleService,
	{
		/** Reopens a thread on GitHub; true when GitHub took it. */
		readonly reopen: (threadId: string) => Effect.Effect<boolean>
		/** Reopens the thread, then drops the answer's flag; true only when both landed. */
		readonly settleAnswer: (
			threadId: string,
			answer: SettledAnswer
		) => Effect.Effect<boolean>
		/**
		 * Whether the thread's newest answer of the token's app is unsettled, from the whole thread
		 * when the read's windows do not show it; a failed read, or one that left a comment out,
		 * counts as unsettled.
		 */
		readonly isUnsettledThread: (
			thread: ReviewThread
		) => Effect.Effect<boolean, never, OwnedIdentities>
		/**
		 * Ids of waiting threads an admin or an allowed login resolved on GitHub, unless the thread's
		 * newest app answer is unsettled, so that resolution may predate it. None once a list read of
		 * the run left a node out (`isReadIncomplete`).
		 */
		readonly getCleared: (
			input: ClearedInput
		) => Effect.Effect<ReadonlySet<string>, never, OwnedIdentities>
		/**
		 * The threads with `unsettled` known for every resolved bug thread whose windows do not show
		 * it: such a thread is read whole (`isUnsettledThread`), and a failed read, or a thread
		 * missing from `raw`, marks it unsettled, so `isOpenBug` counts it open.
		 */
		readonly resolveUnsettled: (
			threads: readonly BotThread[],
			raw: readonly ReviewThread[]
		) => Effect.Effect<readonly BotThread[], never, OwnedIdentities>
		/**
		 * Settles every thread an owned identity started whose newest answer of the token's app is
		 * unsettled; only that answer is edited. The ids still unsettled.
		 */
		readonly settle: (
			threads: readonly ReviewThread[]
		) => Effect.Effect<readonly string[], never, OwnedIdentities>
	}
>()('mng-review/ThreadSettleService') {}

export const ThreadSettleServiceLive = Layer.effect(
	ThreadSettleService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService

		const reopen = (threadId: string) =>
			api.unresolveThread(threadId).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false)
			)

		const settleAnswer = Effect.fn('ThreadSettleService.settleAnswer')(
			function* (threadId: string, answer: SettledAnswer) {
				if (!(yield* reopen(threadId))) return false
				const body = toSettledAnswer(answer.body)
				if (answer.databaseId === null || body === undefined) return false
				return yield* api.updateThreadComment(answer.databaseId, body).pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false)
				)
			}
		)

		/**
		 * The comments that show the newest app answer: the latest window, or the whole thread. A read
		 * that failed, or left a comment out, is unknown, since that comment may be the answer.
		 */
		const readAnswers = Effect.fn('ThreadSettleService.readAnswers')(function* (
			thread: ReviewThread
		) {
			const { current } = yield* OwnedIdentities
			const window = getWindowUnsettled(thread, [current])
			if (window === false) return []
			if (window) return thread.latest?.nodes ?? []
			const read = yield* readListed(api.listThreadComments(thread.id)).pipe(
				Effect.orElseSucceed(() => undefined)
			)
			return read?.incomplete === false ? read.value : undefined
		})

		const isUnsettledThread = Effect.fn(
			'ThreadSettleService.isUnsettledThread'
		)(function* (thread: ReviewThread) {
			const { current } = yield* OwnedIdentities
			const comments = yield* readAnswers(thread)
			return comments === undefined || isUnsettled(comments, current)
		})

		const settle = Effect.fn('ThreadSettleService.settle')(function* (
			threads: readonly ReviewThread[]
		) {
			const { current, identities } = yield* OwnedIdentities
			// The app answers only in threads an owned identity started, so a person's long thread is
			// never read whole; after an app switch the current app answers in the previous one's.
			const started = threads.filter(thread => {
				const author = thread.comments.nodes[0]?.author
				return (
					author !== null &&
					author !== undefined &&
					isOwnedBot(author, identities)
				)
			})
			const left = yield* Effect.forEach(
				started,
				thread =>
					Effect.gen(function* () {
						const comments = yield* readAnswers(thread)
						if (comments === undefined) return [thread.id]
						const answer = getUnsettledAnswer(comments, current)
						if (!answer) return []
						return (yield* settleAnswer(thread.id, answer)) ? [] : [thread.id]
					}),
				{ concurrency: 1 }
			)
			return left.flat()
		})

		const getCleared = Effect.fn('ThreadSettleService.getCleared')(function* (
			input: ClearedInput
		) {
			const resolved = input.waiting.flatMap(id => {
				const resolver = input.resolvers.get(id)
				return resolver === undefined ? [] : [{ id, resolver }]
			})
			const logins = [
				...new Set(resolved.map(entry => entry.resolver.toLowerCase())),
			]
			const entries = yield* Effect.forEach(
				logins,
				login =>
					api.getCollaboratorRole(login).pipe(
						Effect.map(access => [[login, access] as const]),
						Effect.orElseSucceed(() => [])
					),
				{ concurrency: 1 }
			)
			const roles = new Map(entries.flat())
			const cleared = yield* Effect.filter(
				resolved.filter(entry =>
					getOwnerCleared(entry.resolver, roles, input.allow)
				),
				entry => {
					const thread = input.threads.find(raw => raw.id === entry.id)
					if (!thread) return Effect.succeed(false)
					return isUnsettledThread(thread).pipe(
						Effect.map(unsettled => !unsettled)
					)
				},
				{ concurrency: 1 }
			)
			// A read that left a node out may miss the answer or resolution that keeps the wait.
			if (yield* isReadIncomplete) return new Set<string>()
			return new Set(cleared.map(entry => entry.id))
		})

		const resolveUnsettled = Effect.fn('ThreadSettleService.resolveUnsettled')(
			function* (threads: readonly BotThread[], raw: readonly ReviewThread[]) {
				return yield* Effect.forEach(
					threads,
					thread => {
						if (
							!thread.resolved ||
							thread.marker.kind !== 'bug' ||
							thread.unsettled !== undefined
						)
							return Effect.succeed(thread)
						const found = raw.find(entry => entry.id === thread.id)
						if (!found) return Effect.succeed({ ...thread, unsettled: true })
						return isUnsettledThread(found).pipe(
							Effect.map(unsettled => ({ ...thread, unsettled }))
						)
					},
					{ concurrency: 1 }
				)
			}
		)

		return {
			reopen,
			settleAnswer,
			isUnsettledThread,
			resolveUnsettled,
			settle,
			getCleared,
		}
	})
)
