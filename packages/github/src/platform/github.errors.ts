import { Schema } from 'effect'

/** A GitHub API call failed: the request, the answer's status when there was one, and why. */
export class GitHubApiError extends Schema.TaggedError<GitHubApiError>()(
	'GitHubApiError',
	{
		/** The call, such as `createReview`; never a URL or a token. */
		operation: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		reason: Schema.String,
		/** GitHub answered with GraphQL errors: the request reached it and was refused. */
		graphqlErrors: Schema.optionalKey(Schema.Boolean),
		/** The `type` of each GraphQL error, `null` where GitHub gave none. */
		graphqlTypes: Schema.optionalKey(
			Schema.Array(Schema.NullOr(Schema.String))
		),
		/** The answer's headers said the token hit a rate limit: `retry-after` or no requests left. */
		rateLimited: Schema.optionalKey(Schema.Boolean),
	}
) {
	override get message(): string {
		const status = this.status === undefined ? '' : ` (HTTP ${this.status})`
		return `GitHub ${this.operation} failed${status}: ${this.reason}`
	}
}
