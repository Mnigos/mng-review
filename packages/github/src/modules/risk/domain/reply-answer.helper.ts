import { type AnswerEntry, PERSON_TYPE } from '@mng-review/domain'
import type { BotIdentity } from '../../../platform/bot-identity.helper'
import type { ThreadComment } from '../../../platform/github-api.schema'
import { isBotComment } from '../../publish/domain/bot-thread.helper'
import {
	hasBotMarker,
	parseReplyMarker,
} from '../../publish/domain/publish-marker.parser'
import { type CommentVersion, isAnswered } from './answer.helper'
import { isAppAuthored } from './risk-history.helper'

/** A comment's id, body and times as GraphQL gives them. */
type TimedComment = Pick<
	ThreadComment,
	'databaseId' | 'body' | 'createdAt' | 'lastEditedAt'
>

/**
 * Whose comments a reply read weighs: `current`, the app whose answers alone name replies, and
 * `identities`, every owned bot, whose comments are never replies.
 */
export interface ReplyIdentities {
	readonly current: BotIdentity
	readonly identities: readonly BotIdentity[]
}

/** A thread reply at the version a read saw, with its author's login. */
export interface ReplyVersion extends CommentVersion {
	readonly author: string
}

/**
 * The comment at the version the read saw: its edit time, or its creation time when unedited.
 * `undefined` for a comment GitHub gave without an id or a time, which no answer can name.
 */
export function toCommentVersion(
	comment: TimedComment
): CommentVersion | undefined {
	const at = comment.lastEditedAt ?? comment.createdAt
	if (comment.databaseId === null || at === undefined) return undefined
	return { id: comment.databaseId, at, body: comment.body }
}

/**
 * Whether an entry from an answer created before the reply's current edit time counts: its run
 * must pass the run checks and be created after that time. Without one, no such entry counts.
 */
export type EntryQualifier = (
	entry: AnswerEntry,
	version: Pick<CommentVersion, 'at'>
) => boolean

/**
 * The converse entries that can answer a reply at `version`: reply markers of the current app's
 * own answers no one else edited, posted at or after the reply's current edit time. A previous
 * identity's answers name nothing. An answer created before it could only name it through a later
 * edit, so its entries count only when `qualifies` says their run does.
 */
export function getThreadAnswerEntries(
	comments: readonly ThreadComment[],
	app: BotIdentity,
	version: Pick<CommentVersion, 'at'>,
	qualifies?: EntryQualifier
): AnswerEntry[] {
	return getEntriesFor(toThreadAnswers(comments, app), version, qualifies)
}

/** The converse entries of one app answer, with the answer's creation time. */
interface ThreadAnswer {
	readonly createdAt: string | undefined
	readonly entries: readonly AnswerEntry[]
}

/** The current app's own answers in a thread, each marker parsed once. */
function toThreadAnswers(
	comments: readonly ThreadComment[],
	app: BotIdentity
): ThreadAnswer[] {
	return comments
		.filter(comment => isAppAuthored(comment, app))
		.map(comment => ({
			createdAt: comment.createdAt,
			entries: parseReplyMarker(comment.body)?.answers ?? [],
		}))
}

/** `getThreadAnswerEntries` over answers already parsed. */
function getEntriesFor(
	answers: readonly ThreadAnswer[],
	version: Pick<CommentVersion, 'at'>,
	qualifies?: EntryQualifier
): AnswerEntry[] {
	return answers.flatMap(answer => {
		if (answer.createdAt !== undefined && answer.createdAt >= version.at)
			return answer.entries
		return answer.entries.filter(entry => qualifies?.(entry, version) === true)
	})
}

/**
 * The replies in a thread the converse must name: every comment of a person (`User`, not an owned
 * bot, not ending with a bot marker) whose login is among `writers`, that no answer of the current
 * app in the thread names at its current version, oldest first. An older reply edited after an
 * answer, and replies from before the rollout or answered only by a previous identity, are among
 * them.
 */
export function getUnnamedReplies(
	comments: readonly ThreadComment[],
	owned: ReplyIdentities,
	writers: ReadonlySet<string>,
	qualifies?: EntryQualifier
): ReplyVersion[] {
	const answers = toThreadAnswers(comments, owned.current)
	return comments.flatMap(comment => {
		const { author } = comment
		if (
			author?.__typename !== PERSON_TYPE ||
			!writers.has(author.login.toLowerCase()) ||
			isBotComment(comment, owned.identities) ||
			hasBotMarker(comment.body)
		)
			return []
		const version = toCommentVersion(comment)
		if (
			!version ||
			isAnswered(
				version,
				{ kind: 'converse' },
				getEntriesFor(answers, version, qualifies)
			)
		)
			return []
		return [{ ...version, author: author.login }]
	})
}

/**
 * Whether a reply in `unnamed` comes after the comment at `index`: a later writer's reply no app
 * answer names at its current version is answered first. A later reply already named does not
 * count, so an older reply edited after a later one was answered still gets its answer.
 */
export function hasLaterUnnamed(
	comments: readonly ThreadComment[],
	index: number,
	unnamed: readonly ReplyVersion[]
): boolean {
	const later = new Set(
		comments.slice(index + 1).flatMap(comment => comment.databaseId ?? [])
	)
	return unnamed.some(entry => later.has(entry.id))
}
