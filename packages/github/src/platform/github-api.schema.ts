import { Schema } from 'effect'

/** Who wrote a comment, as GraphQL names it: a bot's login has no `[bot]` suffix there. */
export const commentAuthorSchema = Schema.Struct({
	__typename: Schema.String,
	login: Schema.String,
})
export type CommentAuthor = typeof commentAuthorSchema.Type

/** Who last edited a comment, with its type, so a user named like the bot is told apart; `null` when nobody did. */
const commentEditorSchema = Schema.NullOr(commentAuthorSchema)

/** A comment in a review thread, with its last editor and the commit it was written against. */
export const threadCommentSchema = Schema.Struct({
	databaseId: Schema.NullOr(Schema.Number),
	body: Schema.String,
	author: Schema.NullOr(commentAuthorSchema),
	editor: commentEditorSchema,
	originalCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
})
export type ThreadComment = typeof threadCommentSchema.Type

/** A review thread on a pull request with its first comment, which carries the bot's marker. */
export const reviewThreadSchema = Schema.Struct({
	id: Schema.String,
	isResolved: Schema.Boolean,
	isOutdated: Schema.Boolean,
	path: Schema.String,
	/** The line at the head; `null` once the line left the diff or for a file-level thread. */
	line: Schema.NullOr(Schema.Number),
	originalLine: Schema.NullOr(Schema.Number),
	subjectType: Schema.optionalKey(Schema.String),
	comments: Schema.Struct({
		totalCount: Schema.Number,
		nodes: Schema.Array(threadCommentSchema),
	}),
	/** The thread's latest comment, which tells whether the bot's last reply closed it. */
	latest: Schema.optionalKey(
		Schema.Struct({ nodes: Schema.Array(threadCommentSchema) })
	),
})
export type ReviewThread = typeof reviewThreadSchema.Type

/** A conversation comment on the pull request, with its last editor and whether it is hidden. */
export const pullRequestCommentSchema = Schema.Struct({
	/** The GraphQL node id, which `minimizeComment` takes. */
	id: Schema.String,
	databaseId: Schema.NullOr(Schema.Number),
	isMinimized: Schema.Boolean,
	body: Schema.String,
	author: Schema.NullOr(commentAuthorSchema),
	editor: commentEditorSchema,
})
export type PullRequestComment = typeof pullRequestCommentSchema.Type

/** Where a GraphQL connection stops and whether more pages follow. */
export const pageInfoSchema = Schema.Struct({
	hasNextPage: Schema.Boolean,
	endCursor: Schema.NullOr(Schema.String),
})

/** One page of a connection; a node GitHub could not resolve is `null`. */
export interface ConnectionPage<TNode> {
	readonly pageInfo: typeof pageInfoSchema.Type
	readonly nodes: readonly (TNode | null)[]
}

/** GraphQL's errors, present when the query or a field failed, even beside data. */
const graphqlErrorsSchema = Schema.optionalKey(
	Schema.Array(
		Schema.Struct({
			message: Schema.String,
			type: Schema.optionalKey(Schema.String),
		})
	)
)

/** The answer to the review threads query. */
export const reviewThreadsAnswerSchema = Schema.Struct({
	data: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				repository: Schema.NullOr(
					Schema.Struct({
						pullRequest: Schema.NullOr(
							Schema.Struct({
								reviewThreads: Schema.Struct({
									pageInfo: pageInfoSchema,
									nodes: Schema.Array(Schema.NullOr(reviewThreadSchema)),
								}),
							})
						),
					})
				),
			})
		)
	),
	errors: graphqlErrorsSchema,
})
export type ReviewThreadsAnswer = typeof reviewThreadsAnswerSchema.Type

/** The answer to the pull request comments query. */
export const pullRequestCommentsAnswerSchema = Schema.Struct({
	data: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				repository: Schema.NullOr(
					Schema.Struct({
						pullRequest: Schema.NullOr(
							Schema.Struct({
								comments: Schema.Struct({
									pageInfo: pageInfoSchema,
									nodes: Schema.Array(Schema.NullOr(pullRequestCommentSchema)),
								}),
							})
						),
					})
				),
			})
		)
	),
	errors: graphqlErrorsSchema,
})
export type PullRequestCommentsAnswer =
	typeof pullRequestCommentsAnswerSchema.Type

/** The answer to a mutation: GitHub's errors, if any; the data is not needed. */
export const mutationAnswerSchema = Schema.Struct({
	errors: graphqlErrorsSchema,
})
export type MutationAnswer = typeof mutationAnswerSchema.Type

/** What a create call answers with that the caller needs: the new object's id. */
export const createdSchema = Schema.Struct({ id: Schema.Number })

/** GitHub's error body. */
export const errorBodySchema = Schema.Struct({ message: Schema.String })

/** An open pull request as the sweep needs it: its number and head commit. */
export const openPullRequestSchema = Schema.Struct({
	number: Schema.Number,
	head: Schema.Struct({ sha: Schema.String }),
})
export type OpenPullRequest = typeof openPullRequestSchema.Type

/** One commit status with who set it. */
export const commitStatusSchema = Schema.Struct({
	id: Schema.Number,
	state: Schema.String,
	context: Schema.String,
	description: Schema.NullOr(Schema.String),
	creator: Schema.NullOr(
		Schema.Struct({ login: Schema.String, type: Schema.String })
	),
})
export type CommitStatus = typeof commitStatusSchema.Type

/** A pull request as a command run needs it: state, repositories, commits and what the planner sees. */
export const pullRequestSchema = Schema.Struct({
	number: Schema.Number,
	state: Schema.String,
	draft: Schema.optionalKey(Schema.Boolean),
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
	user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
	labels: Schema.Array(Schema.Struct({ name: Schema.String })),
	base: Schema.Struct({
		sha: Schema.String,
		ref: Schema.String,
		repo: Schema.Struct({ full_name: Schema.String }),
	}),
	head: Schema.Struct({
		sha: Schema.String,
		repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
	}),
})
export type PullRequest = typeof pullRequestSchema.Type

/** A conversation comment read by its id, with who wrote it and through which app. */
export const issueCommentSchema = Schema.Struct({
	id: Schema.Number,
	body: Schema.NullOr(Schema.String),
	user: Schema.NullOr(
		Schema.Struct({ login: Schema.String, type: Schema.String })
	),
	performed_via_github_app: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
})
export type IssueComment = typeof issueCommentSchema.Type

/** A collaborator's role on the repository: `admin`, `maintain`, `write`, `triage`, `read` or a custom role. */
export const collaboratorRoleSchema = Schema.Struct({
	role_name: Schema.String,
})
