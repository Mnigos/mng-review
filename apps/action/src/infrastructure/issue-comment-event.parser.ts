import { ConfigError, formatSchemaIssue } from '@mng-review/domain'
import type { CommandComment } from '@mng-review/github'
import { Effect, Predicate, Schema } from 'effect'
import { issueCommentEventSchema } from './issue-comment-event.schema'
import { EVENT_PATH_VARIABLE } from './pull-request-event.parser'

const decodeEvent = Schema.decodeUnknownEffect(
	Schema.fromJsonString(issueCommentEventSchema)
)

/**
 * Parses the JSON payload of an `issue_comment` event into the comment a command check reads,
 * with `eventName` from the runner. A payload that is not a comment fails with a `ConfigError`
 * naming `GITHUB_EVENT_PATH`.
 */
export function parseIssueCommentEvent(
	text: string,
	eventName: string
): Effect.Effect<CommandComment, ConfigError> {
	return decodeEvent(text).pipe(
		Effect.mapError(
			error =>
				new ConfigError({
					source: EVENT_PATH_VARIABLE,
					reason: `not a comment event: ${formatSchemaIssue(error.issue)}`,
				})
		),
		Effect.map(({ action, comment, issue }) => ({
			eventName,
			action,
			id: comment.id,
			body: comment.body ?? '',
			login: comment.user?.login ?? '',
			type: comment.user?.type ?? '',
			viaApp: Predicate.isNotNullish(comment.performed_via_github_app),
			issueNumber: issue.number,
			onPullRequest: Predicate.isNotNullish(issue.pull_request),
		}))
	)
}
