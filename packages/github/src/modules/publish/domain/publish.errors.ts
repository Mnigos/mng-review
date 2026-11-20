import { Schema } from 'effect'
import { GitHubApiError } from '../../../platform/github.errors'

/**
 * The summary write failed after the run may have posted threads, so the head's commit status no
 * longer matches the pull request. Its message is the GitHub failure's own.
 */
export class PublishIncompleteError extends Schema.TaggedError<PublishIncompleteError>()(
	'PublishIncompleteError',
	{ error: GitHubApiError }
) {
	override get message(): string {
		return this.error.message
	}
}
