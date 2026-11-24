import type { AnsweredComment, AnswerEntry } from '@mng-review/domain'
import { Context, Effect, Layer } from 'effect'
import { isNotFound } from '../../../platform/github-api.helper'
import type {
	CollaboratorRole,
	ThreadComment,
} from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { hasWriteAccess } from '../../command/domain/command-access.helper'
import {
	isAnswered,
	toAnswerEntry,
	toAnsweredComment,
} from '../../risk/domain/answer.helper'
import {
	getThreadAnswerEntries,
	getUnnamedReplies,
	hasLaterUnnamed,
	toCommentVersion,
	type ReplyVersion,
} from '../../risk/domain/reply-answer.helper'
import { toBodyDigest } from '../domain/bot-thread.helper'
import type { AppliedReply } from '../domain/publish.types'
import { isAnswerableThread } from '../domain/thread-conversation.helper'
import type { PendingThread, ReplyCollectInput } from './thread-reply.service'

/**
 * The unnamed replies an answer names: only the versions the collection saw (`seen`), so an edit
 * made while the review ran waits for the next run; every one when the collection recorded none.
 */
function getEligible(
	unnamed: readonly ReplyVersion[],
	seen: readonly AnsweredComment[] | undefined
): readonly ReplyVersion[] {
	if (!seen) return unnamed
	return unnamed.filter(reply => {
		const answered = toAnsweredComment(reply)
		return seen.some(
			entry =>
				entry.id === answered.id &&
				entry.at === answered.at &&
				entry.digest === answered.digest
		)
	})
}

/** The decided reply as the answer's read confirms it, with the entry the answer carries. */
export interface NamedReply {
	readonly entry: AnswerEntry | undefined
}

export class ReplyNamingService extends Context.Service<
	ReplyNamingService,
	{
		/** A login's access, or `undefined` when GitHub does not answer. */
		readonly readRole: (
			login: string
		) => Effect.Effect<CollaboratorRole | undefined>
		/** The logins, lowercased, that have write access; a failed lookup counts as none. */
		readonly getWriters: (
			logins: readonly string[]
		) => Effect.Effect<ReadonlySet<string>>
		/**
		 * The same set for a reader that must not guess: a login that is no collaborator has no
		 * access, any other failed lookup fails the call, so the sweep skips the repository.
		 */
		readonly requireWriters: (
			logins: readonly string[]
		) => Effect.Effect<ReadonlySet<string>, GitHubApiError>
		readonly readNamed: (
			applied: AppliedReply,
			run: number | undefined,
			held?: number
		) => Effect.Effect<NamedReply | undefined, never, OwnedIdentities>
		/**
		 * Whether a writer's reply after the comment at `index` waits for an answer: one no app answer
		 * names at its current version.
		 */
		readonly hasLaterReply: (
			comments: readonly ThreadComment[],
			index: number
		) => Effect.Effect<boolean, never, OwnedIdentities>
		/** The writer replies in the thread no app answer names, at the versions this read saw. */
		readonly getNamedVersions: (
			comments: readonly ThreadComment[]
		) => Effect.Effect<readonly AnsweredComment[], never, OwnedIdentities>
		readonly findOlderReplies: (
			input: ReplyCollectInput,
			pending: readonly PendingThread[]
		) => Effect.Effect<readonly PendingThread[], never, OwnedIdentities>
	}
>()('mng-review/ReplyNamingService') {}

export const ReplyNamingServiceLive = Layer.effect(
	ReplyNamingService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService

		/** A login's access, or `undefined` when GitHub does not answer. */
		const readRole = Effect.fn('ReplyNamingService.readRole')(function* (
			login: string
		) {
			return yield* api.getCollaboratorRole(login).pipe(
				Effect.map((access): CollaboratorRole | undefined => access),
				Effect.orElseSucceed(() => undefined)
			)
		})

		/** The logins, lowercased, that have write access; one lookup per login, a failed one counts as none. */
		const getWriters = Effect.fn('ReplyNamingService.getWriters')(function* (
			logins: readonly string[]
		) {
			const distinct = [...new Set(logins.map(login => login.toLowerCase()))]
			const writers = yield* Effect.filter(
				distinct,
				login =>
					readRole(login).pipe(
						Effect.map(access => access !== undefined && hasWriteAccess(access))
					),
				{ concurrency: 1 }
			)
			return new Set(writers)
		})

		const requireWriters = Effect.fn('ReplyNamingService.requireWriters')(
			function* (logins: readonly string[]) {
				const distinct = [...new Set(logins.map(login => login.toLowerCase()))]
				const writers = yield* Effect.filter(
					distinct,
					login =>
						api.getCollaboratorRole(login).pipe(
							Effect.map(hasWriteAccess),
							Effect.catchIf(isNotFound, () => Effect.succeed(false))
						),
					{ concurrency: 1 }
				)
				return new Set(writers)
			}
		)

		/**
		 * The decided reply as the whole thread shows it right before the answer: unchanged since the
		 * decision, by a writer, with no later writer's reply that no app answer names at its current
		 * version (that one is answered first), and no app answer naming it at this version; while
		 * answers name replies, its author's write access is read again here whichever comment is
		 * latest now. `undefined` otherwise or when the read fails. A later reply already named does not stop it,
		 * so an older reply edited after a later one was answered still gets its answer. The answer's
		 * entry names every reply by a writer in the thread no app answer names yet. A resolved thread
		 * is answered only while `held`, the dispatched reply, is among those replies. The reply
		 * mutation has no precondition, so this read narrows the window for an edit or a newer comment
		 * but cannot close it.
		 */
		const readNamed = Effect.fn('ReplyNamingService.readNamed')(function* (
			applied: AppliedReply,
			run: number | undefined,
			held?: number
		) {
			const owned = yield* OwnedIdentities
			const comments = yield* api
				.listThreadComments(applied.thread.id)
				.pipe(Effect.orElseSucceed((): readonly ThreadComment[] => []))
			const index = comments.findLastIndex(
				comment => comment.databaseId === applied.commentId
			)
			const reply = comments[index]
			const digest = applied.digest ?? applied.thread.latestDigest
			if (!reply || toBodyDigest(reply.body) !== digest) return undefined
			// Without a run nothing is named: only the latest reply is answered, as before the rating.
			if (run === undefined && index !== comments.length - 1) return undefined
			const version = toCommentVersion(reply)
			if (
				version &&
				isAnswered(
					version,
					{ kind: 'converse' },
					getThreadAnswerEntries(comments, owned.current, version)
				)
			)
				return undefined
			const older = index < comments.length - 1
			const needsWriters = older || run !== undefined
			const writers = needsWriters
				? yield* getWriters(
						comments.flatMap(comment => comment.author?.login ?? [])
					)
				: new Set<string>()
			// The latest reply's author was checked before; an older one's is checked here.
			if (older && !writers.has(reply.author?.login.toLowerCase() ?? ''))
				return undefined
			const unnamed = getUnnamedReplies(comments, owned, writers)
			// The reply itself must still wait: by a writer this read checked, named by no answer.
			if (
				run !== undefined &&
				!unnamed.some(entry => entry.id === applied.commentId)
			)
				return undefined
			if (hasLaterUnnamed(comments, index, unnamed)) return undefined
			if (applied.thread.resolved && !unnamed.some(entry => entry.id === held))
				return undefined
			return {
				entry:
					run === undefined
						? undefined
						: toAnswerEntry(
								run,
								'converse',
								getEligible(unnamed, applied.named)
							),
			}
		})

		const getNamedVersions = Effect.fn('ReplyNamingService.getNamedVersions')(
			function* (comments: readonly ThreadComment[]) {
				const owned = yield* OwnedIdentities
				const writers = yield* getWriters(
					comments.flatMap(comment => comment.author?.login ?? [])
				)
				return getUnnamedReplies(comments, owned, writers).map(
					toAnsweredComment
				)
			}
		)

		const hasLaterReply = Effect.fn('ReplyNamingService.hasLaterReply')(
			function* (comments: readonly ThreadComment[], index: number) {
				if (index === comments.length - 1) return false
				const owned = yield* OwnedIdentities
				const writers = yield* getWriters(
					comments
						.slice(index + 1)
						.flatMap(comment => comment.author?.login ?? [])
				)
				return hasLaterUnnamed(
					comments,
					index,
					getUnnamedReplies(comments, owned, writers)
				)
			}
		)

		/**
		 * Threads the converse answers whose latest comment is not a person's pending reply but that
		 * hold an older reply by a writer no app answer names at its current version, read whole; the
		 * newest such reply is the one to decide on.
		 */
		const findOlderReplies = Effect.fn('ReplyNamingService.findOlderReplies')(
			function* (input: ReplyCollectInput, pending: readonly PendingThread[]) {
				const owned = yield* OwnedIdentities
				const taken = new Set(pending.map(entry => entry.thread.id))
				const candidates = input.threads.filter(
					thread =>
						!taken.has(thread.id) &&
						thread.replies > 0 &&
						isAnswerableThread(thread, input.waiting, input.held !== undefined)
				)
				const found = yield* Effect.forEach(
					candidates,
					thread =>
						api.listThreadComments(thread.id).pipe(
							Effect.flatMap(comments =>
								getWriters(
									comments.flatMap(comment => comment.author?.login ?? [])
								).pipe(
									Effect.map(writers =>
										getUnnamedReplies(comments, owned, writers)
									)
								)
							),
							Effect.map((unnamed): PendingThread[] => {
								const reply = unnamed.at(-1)
								if (!reply) return []
								if (
									thread.resolved &&
									!unnamed.some(entry => entry.id === input.held)
								)
									return []
								return [
									{
										thread,
										ref: { commentId: reply.id, author: reply.author },
									},
								]
							}),
							Effect.orElseSucceed((): PendingThread[] => [])
						),
					{ concurrency: 1 }
				)
				return found.flat()
			}
		)

		return {
			readRole,
			getWriters,
			requireWriters,
			readNamed,
			hasLaterReply,
			getNamedVersions,
			findOlderReplies,
		}
	})
)
