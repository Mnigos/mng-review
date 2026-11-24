import { Schema } from 'effect'
import { GitHubApiError } from '../../../platform/github.errors'

/**
 * A summary write would end with a marker no read decodes, such as more answer entries than
 * `MAX_ANSWER_ENTRIES`. Nothing is written, so the run fails and its `error` status stays.
 */
export class SummaryMarkerError extends Schema.TaggedError<SummaryMarkerError>()(
	'SummaryMarkerError',
	{ answers: Schema.Int }
) {
	override get message(): string {
		return `The summary marker would not decode (${this.answers} answer entries); the summary was not written`
	}
}

/**
 * The summary write failed after the run may have posted threads, so the head's commit status no
 * longer matches the pull request. Its message is the failure's own.
 */
export class PublishIncompleteError extends Schema.TaggedError<PublishIncompleteError>()(
	'PublishIncompleteError',
	{ error: Schema.Union([GitHubApiError, SummaryMarkerError]) }
) {
	override get message(): string {
		return this.error.message
	}
}
