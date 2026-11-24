import {
	type AnsweredComment,
	type AnswerEntry,
	type AnswerKind,
	toAnswerDigest,
} from '@mng-review/domain'

/** A comment at the version a read saw: its id, its edit time and its whole body. */
export interface CommentVersion {
	readonly id: number
	/** `lastEditedAt`, or the creation time of an unedited comment, as GraphQL gives it. */
	readonly at: string
	readonly body: string
}

/** What answers a comment: the kind it needs and, for `run <agent>`, the agent. */
export type AnswerNeed =
	| { readonly kind: 'converse' }
	| { readonly kind: 'review' }
	| { readonly kind: 'run'; readonly agent: string }

/** The answer kinds that answer each need. */
const ANSWERING_KINDS = {
	converse: ['converse'],
	review: ['review', 'cap', 'deny'],
	run: ['run', 'deny'],
} as const satisfies Record<AnswerNeed['kind'], readonly AnswerKind[]>

/** The entry an answer carries for one comment at the version the run read. */
export function toAnsweredComment(comment: CommentVersion): AnsweredComment {
	return {
		id: comment.id,
		at: comment.at,
		digest: toAnswerDigest(comment.body),
	}
}

/**
 * True when the entry names the comment at its current version: the same id, an edit time no
 * older than the comment's, and the digest of its current body, so two edits in one second differ.
 */
export function namesComment(
	entry: Pick<AnswerEntry, 'ids'>,
	comment: CommentVersion
): boolean {
	const digest = toAnswerDigest(comment.body)
	return entry.ids.some(
		named =>
			named.id === comment.id &&
			named.at >= comment.at &&
			named.digest === digest
	)
}

/**
 * True when an entry's kind answers the need: `converse` a reply; `review`, `cap` or `deny` a
 * `review` command; `run` with the same agent, or `deny`, a `run <agent>` command.
 */
export function fitsNeed(
	entry: Pick<AnswerEntry, 'kind' | 'agent'>,
	need: AnswerNeed
): boolean {
	const kinds: readonly AnswerKind[] = ANSWERING_KINDS[need.kind]
	if (!kinds.includes(entry.kind)) return false
	return (
		need.kind !== 'run' || entry.kind === 'deny' || entry.agent === need.agent
	)
}

/** The kinds whose run must be created after the command they answer (`isQualified`). */
const RUN_ANSWER_KINDS = [
	'review',
	'run',
] as const satisfies readonly AnswerKind[]

/**
 * True when the entry's run qualifies for the comment as the merge tool checks it: a `review` or
 * `run` entry only when its run was created after the comment's current edit time (GitHub's times
 * are whole seconds, so the same second does not count). Denials and converse answers are new
 * comments written after their read, so any run qualifies.
 */
export function isQualified(
	entry: Pick<AnswerEntry, 'kind' | 'created'>,
	comment: Pick<CommentVersion, 'at'>
): boolean {
	const kinds: readonly AnswerKind[] = RUN_ANSWER_KINDS
	if (!kinds.includes(entry.kind)) return true
	return entry.created !== undefined && entry.created > comment.at
}

/**
 * True when any of the trusted app answers' entries names the comment at its version, by a fitting
 * kind and a qualifying run (`isQualified`).
 */
export function isAnswered(
	comment: CommentVersion,
	need: AnswerNeed,
	entries: readonly AnswerEntry[]
): boolean {
	return entries.some(
		entry =>
			fitsNeed(entry, need) &&
			namesComment(entry, comment) &&
			isQualified(entry, comment)
	)
}

/**
 * The entry an answer of `kind` carries for the comments it handled, with its run's creation time
 * when given; `undefined` when it names none.
 */
export function toAnswerEntry(
	run: number,
	kind: AnswerKind,
	comments: readonly CommentVersion[],
	agent?: string,
	created?: string
): AnswerEntry | undefined {
	const [first, ...rest] = comments.map(toAnsweredComment)
	if (!first) return undefined
	return {
		run,
		kind,
		...(kind === 'run' && agent !== undefined ? { agent } : {}),
		ids: [first, ...rest],
		...(created === undefined ? {} : { created }),
	}
}
