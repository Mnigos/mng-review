import { gateRun, type ReviewConfig } from '@mng-review/domain'
import type { PriorRun, PullRequestEvent } from './shadow-run.types'

/** Actions that start a run whatever the run count: a draft that became ready. */
const EXEMPT_ACTIONS = ['ready_for_review'] as const
export const FORK_REASON = 'fork pull request; the workflow never reviews forks'

/**
 * Why the run stops at `limits.max_runs_per_pr`, or `undefined` when it goes on: a manual trigger
 * and a pull request that just became ready for review are exempt.
 */
export function getRunLimitReason(
	prior: PriorRun | undefined,
	limit: number,
	event: Pick<PullRequestEvent, 'action' | 'pr'>
): string | undefined {
	if (!prior || prior.runs < limit || event.pr.trigger === 'manual')
		return undefined
	if (EXEMPT_ACTIONS.some(action => action === event.action)) return undefined
	return `run limit reached: ${prior.runs} of ${limit} runs on this pull request; a manual command still runs`
}

/**
 * Why the base rules keep this pull request from a run: a fork, a `skip` rule, or the run limit
 * against the earlier runs. `undefined` when the run goes on. The prepare step decides with it
 * before the review, and the publish step again before any write, from its own event and reads.
 */
export function getGateReason(
	event: Pick<PullRequestEvent, 'action' | 'pr'>,
	config: ReviewConfig,
	prior: PriorRun | undefined
): string | undefined {
	if (event.pr.fork) return FORK_REASON
	return (
		gateRun(config, event.pr) ??
		getRunLimitReason(prior, config.limits.max_runs_per_pr, event)
	)
}
