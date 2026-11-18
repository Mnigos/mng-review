import { Schema } from 'effect'

/** A full commit SHA, SHA-1 or SHA-256, so a ref from the event can never read as a git option. */
const commitShaSchema = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u)
)

/** A repository as the event names it; only its full name is read. */
const repositorySchema = Schema.Struct({ full_name: Schema.String })

/** One side of the pull request: its commit, its branch and the repository it lives in. */
const baseSchema = Schema.Struct({
	sha: commitShaSchema,
	ref: Schema.String,
	repo: repositorySchema,
})

/** The head's repository is `null` when the fork it came from was deleted. */
const headSchema = Schema.Struct({
	sha: commitShaSchema,
	ref: Schema.String,
	repo: Schema.NullOr(repositorySchema),
})

/**
 * The part of a `pull_request` or `pull_request_target` payload the review reads. Other keys are
 * ignored. Title, body and labels are written by the pull request's author and stay untrusted.
 */
export const pullRequestEventSchema = Schema.Struct({
	pull_request: Schema.Struct({
		number: Schema.Number,
		title: Schema.String,
		body: Schema.NullOr(Schema.String),
		draft: Schema.optionalKey(Schema.Boolean),
		user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
		labels: Schema.Array(Schema.Struct({ name: Schema.String })),
		base: baseSchema,
		head: headSchema,
	}),
})
export type PullRequestEventPayload = typeof pullRequestEventSchema.Type
