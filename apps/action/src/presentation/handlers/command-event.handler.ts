import { GitHubApiService } from '@mng-review/github'
import { Effect } from 'effect'
import {
	getCommandMismatch,
	toCommandEvent,
} from '../../application/command-event.helper'
import type { CommandEventRead } from '../../application/command-run.types'
import type { CommandTarget } from '../../infrastructure/command-run.config'

/**
 * The pull request an authorized command reviews, read again from the API instead of the comment's
 * event: a closed, moved or fork pull request, or a GitHub error, skips the run.
 */
export const readCommandEvent = Effect.fn('commandEvent.read')(function* (
	target: CommandTarget
) {
	const api = yield* GitHubApiService
	return yield* api.getPullRequest(target.pullNumber).pipe(
		Effect.map((pr): CommandEventRead => {
			const mismatch = getCommandMismatch(pr, target)
			return mismatch === undefined
				? { status: 'ready', event: toCommandEvent(pr, target) }
				: { status: 'skipped', reason: mismatch }
		}),
		Effect.catchTag('GitHubApiError', error =>
			Effect.succeed({
				status: 'skipped',
				reason: `the pull request could not be read: ${error.message}`,
			} satisfies CommandEventRead)
		)
	)
})
