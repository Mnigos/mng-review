import type { PullRequest } from '@mng-review/github'
import type { CommandSettings } from '../infrastructure/runner.client'
import type { PullRequestEvent } from './shadow-run.types'

/**
 * The pull request a command reviews, as the shadow run takes it: the commits the authorize job
 * checked, what the planner sees from the API, a manual trigger and the depth the command asked
 * for. It is never a fork; the authorize job refused those.
 */
export function toCommandEvent(
	pr: PullRequest,
	settings: CommandSettings
): PullRequestEvent {
	const author = pr.user?.login
	return {
		number: settings.pullNumber,
		baseSha: settings.base,
		headSha: settings.head,
		pr: {
			labels: pr.labels.map(label => label.name),
			target: pr.base.ref,
			title: pr.title,
			draft: pr.draft ?? false,
			fork: false,
			trigger: 'manual',
			...(author === undefined ? {} : { author }),
			...(pr.body === null ? {} : { body: pr.body }),
			...(settings.depth === undefined ? {} : { depth: settings.depth }),
		},
	}
}
