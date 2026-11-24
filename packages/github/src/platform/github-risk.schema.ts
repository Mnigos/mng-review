import { Schema } from 'effect'
import {
	type CommentAuthor,
	commentAuthorSchema,
	pageInfoSchema,
} from './github-api.schema'

/** One commit status with who set it and when; the risk readers need every field. */
export const riskCommitStatusSchema = Schema.Struct({
	id: Schema.Number,
	state: Schema.String,
	context: Schema.String,
	description: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	creator: Schema.NullOr(
		Schema.Struct({ login: Schema.String, type: Schema.String })
	),
})
export type RiskCommitStatus = typeof riskCommitStatusSchema.Type

const commitRefSchema = Schema.NullOr(Schema.Struct({ oid: Schema.String }))

/**
 * One timeline item the risk rating reads: a commit, both sides of a force push, or a label added
 * or removed with who did it. GitHub lists the items in the order they happened.
 */
export const timelineItemSchema = Schema.Struct({
	__typename: Schema.String,
	commit: Schema.optionalKey(commitRefSchema),
	beforeCommit: Schema.optionalKey(commitRefSchema),
	afterCommit: Schema.optionalKey(commitRefSchema),
	actor: Schema.optionalKey(Schema.NullOr(commentAuthorSchema)),
	label: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ name: Schema.String }))
	),
})
export type TimelineItem = typeof timelineItemSchema.Type

/** The answer to the timeline query. */
export const timelineAnswerSchema = Schema.Struct({
	data: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				repository: Schema.NullOr(
					Schema.Struct({
						pullRequest: Schema.NullOr(
							Schema.Struct({
								timelineItems: Schema.Struct({
									pageInfo: pageInfoSchema,
									nodes: Schema.Array(Schema.NullOr(timelineItemSchema)),
								}),
							})
						),
					})
				),
			})
		)
	),
	errors: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				message: Schema.String,
				type: Schema.optionalKey(Schema.String),
			})
		)
	),
})

/** The answer to the comment edit query: the comment's body, edit count and one page of edits. */
export const commentEditsAnswerSchema = Schema.Struct({
	data: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				node: Schema.NullOr(
					Schema.Struct({
						body: Schema.String,
						userContentEdits: Schema.optionalKey(
							Schema.NullOr(
								Schema.Struct({
									totalCount: Schema.Number,
									pageInfo: pageInfoSchema,
									nodes: Schema.Array(
										Schema.NullOr(
											Schema.Struct({
												id: Schema.String,
												editor: Schema.NullOr(commentAuthorSchema),
												editedAt: Schema.String,
												diff: Schema.NullOr(Schema.String),
											})
										)
									),
								})
							)
						),
					})
				),
			})
		)
	),
	errors: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				message: Schema.String,
				type: Schema.optionalKey(Schema.String),
			})
		)
	),
})

/**
 * One edit of a comment: its id, who made it (`null` when GitHub no longer names them), when, and
 * the whole text it left (GitHub's `diff`; `null` when GitHub does not give it).
 */
export interface CommentEdit {
	/** GitHub's node id of the edit, the same in every read. */
	readonly id: string
	readonly editor: CommentAuthor | null
	/** GitHub's ISO 8601 time, which orders as text. */
	readonly editedAt: string
	readonly diff: string | null
}

/**
 * A comment's body with its edit count and the edits GitHub listed, in the order it listed
 * them.
 */
export interface CommentEdits {
	readonly body: string
	readonly total: number
	/** Every page GitHub listed; `null` for an edit GitHub listed as a null node. */
	readonly edits: readonly (CommentEdit | null)[]
}
