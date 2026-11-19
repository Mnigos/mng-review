import { Schema } from 'effect'

/**
 * The part of an `issue_comment` payload a command reads. The body is written by the commenter and
 * stays untrusted; it is only parsed, never run or interpolated.
 */
export const issueCommentEventSchema = Schema.Struct({
	comment: Schema.Struct({
		id: Schema.Number,
		body: Schema.NullOr(Schema.String),
		user: Schema.NullOr(
			Schema.Struct({ login: Schema.String, type: Schema.String })
		),
		performed_via_github_app: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
	}),
	issue: Schema.Struct({
		number: Schema.Number,
		pull_request: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
	}),
})
export type IssueCommentEventPayload = typeof issueCommentEventSchema.Type
