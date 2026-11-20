import type { PullRequest } from '@mng-review/github'
import type { CommandTarget } from '../infrastructure/command-run.config'
import type { PullRequestEvent } from './shadow-run.types'

/**
 * Why a command's pull request may no longer be written to: it closed or now comes from a fork.
 * The publish job checks this alone, because a head that moved during the review is a partial run.
 */
export function getCommandStateMismatch(pr: PullRequest): string | undefined {
	if (pr.state !== 'open') return 'the pull request closed after the command'
	if (pr.head.repo?.full_name !== pr.base.repo.full_name)
		return 'the pull request comes from a fork'
	return undefined
}

/**
 * Why an authorized command no longer runs, read again in a later job: the pull request closed,
 * moved to another head, or now comes from a fork. `undefined` when it still matches what the
 * authorize job checked.
 */
export function getCommandMismatch(
	pr: PullRequest,
	target: Pick<CommandTarget, 'head'>
): string | undefined {
	if (pr.state === 'open' && pr.head.sha !== target.head)
		return 'the pull request has a new head since the command; comment again to review it'
	return getCommandStateMismatch(pr)
}

/**
 * The pull request a command reviews, as a run takes it: the commits the authorize job checked,
 * what the planner sees from the API, a manual trigger and the depth the command asked for.
 */
export function toCommandEvent(
	pr: PullRequest,
	target: CommandTarget
): PullRequestEvent {
	const author = pr.user?.login
	return {
		number: target.pullNumber,
		baseSha: target.base,
		headSha: target.head,
		pr: {
			labels: pr.labels.map(label => label.name),
			target: pr.base.ref,
			title: pr.title,
			draft: pr.draft ?? false,
			fork: pr.head.repo?.full_name !== pr.base.repo.full_name,
			trigger: 'manual',
			...(author === undefined ? {} : { author }),
			...(pr.body === null ? {} : { body: pr.body }),
			...(target.depth === undefined ? {} : { depth: target.depth }),
		},
	}
}
