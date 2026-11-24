import type { AnswerEntry } from '@mng-review/domain'
import { type CommentVersion, namesComment } from './answer.helper'

/** A conversation comment as the cap reads it: its version, the command it holds and its author's standing. */
export interface CapComment extends CommentVersion {
	/** The comment holds a `review` command for the handle (`run <agent>` does not count). */
	readonly review: boolean
	/** The author is one the bot acts on (`isActedOnAuthor`). */
	readonly actedOn: boolean
}

/**
 * The `review` commands that count toward the cap on the current head: from acted-on authors,
 * since the head arrived, leaving out those a trusted denial names at their current version, so a
 * writer the owner gate refuses cannot use the cap up. Push runs and sweep dispatches never count.
 */
export function getCountedReviews(
	comments: readonly CapComment[],
	entries: readonly AnswerEntry[]
): CapComment[] {
	const denials = entries.filter(entry => entry.kind === 'deny')
	return comments.filter(
		comment =>
			comment.review &&
			comment.actedOn &&
			!denials.some(entry => namesComment(entry, comment))
	)
}

/** True when the command is past `reviews_per_head`: more counted commands than the cap, itself included. */
export function isOverCap(
	counted: readonly Pick<CapComment, 'id'>[],
	commentId: number,
	cap: number
): boolean {
	const index = counted.findIndex(comment => comment.id === commentId)
	return index === -1 ? counted.length >= cap : index >= cap
}
