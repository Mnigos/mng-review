import {
	ConfigError,
	formatSchemaIssue,
	type PullRequestInfo,
} from '@mng-review/domain'
import { Effect, Schema } from 'effect'
import type { PullRequestEvent } from '../application/shadow-run.types'
import {
	type PullRequestEventPayload,
	pullRequestEventSchema,
} from './pull-request-event.schema'

/** Where the runner puts the event payload; named in errors instead of the file's path. */
export const EVENT_PATH_VARIABLE = 'GITHUB_EVENT_PATH'

const decodeEvent = Schema.decodeUnknownEffect(
	Schema.fromJsonString(pullRequestEventSchema)
)

/** A pull request from another repository, or from a fork that was deleted since. */
function isFork({ pull_request: pr }: PullRequestEventPayload): boolean {
	return pr.head.repo?.full_name !== pr.base.repo.full_name
}

/** What the engine is told about the pull request; a workflow run is never a manual trigger. */
function toPullRequestInfo(payload: PullRequestEventPayload): PullRequestInfo {
	const { pull_request: pr } = payload
	const author = pr.user?.login
	return {
		labels: pr.labels.map(label => label.name),
		target: pr.base.ref,
		title: pr.title,
		draft: pr.draft ?? false,
		fork: isFork(payload),
		trigger: 'auto',
		...(author === undefined ? {} : { author }),
		...(pr.body === null ? {} : { body: pr.body }),
	}
}

/**
 * Parses the JSON payload of a `pull_request` or `pull_request_target` event. A payload without a
 * pull request, or with a malformed commit SHA, fails with a `ConfigError` naming
 * `GITHUB_EVENT_PATH`.
 */
export function parsePullRequestEvent(
	text: string
): Effect.Effect<PullRequestEvent, ConfigError> {
	return decodeEvent(text).pipe(
		Effect.mapError(
			error =>
				new ConfigError({
					source: EVENT_PATH_VARIABLE,
					reason: `not a pull request event: ${formatSchemaIssue(error.issue)}`,
				})
		),
		Effect.map(payload => ({
			...(payload.action === undefined ? {} : { action: payload.action }),
			number: payload.pull_request.number,
			baseSha: payload.pull_request.base.sha,
			headSha: payload.pull_request.head.sha,
			pr: toPullRequestInfo(payload),
		}))
	)
}
