import type { Rules } from '@mng-review/engine'
import type { OpenPullRequest, PullRequest } from '@mng-review/github'
import { toCommandEvent } from './command-event.helper'
import type { RiskReport } from './risk-run.service'
import { getGateReason } from './run-gate.helper'

/** What the checks read of a pull request, from the open list or a read by number. */
type SweptPull = Pick<OpenPullRequest, 'draft' | 'base' | 'head'>

/**
 * The pre-model checks a push run makes, as the sweep can read them from the pull request list:
 * not a fork, into the default branch, not a draft. The rules already loaded from the default
 * branch, so `.mng/` loads.
 */
export function passesSweepChecks(
	pr: SweptPull,
	defaultBranch: string
): boolean {
	return (
		pr.head.repo?.full_name === pr.base.repo.full_name &&
		pr.base.ref === defaultBranch &&
		pr.draft !== true
	)
}

/**
 * The checks each kind of dispatched run makes before any model call, as the sweep reads them.
 * The converse's: `passesSweepChecks`. The dispatched rating's: those, plus the gate its review job
 * applies to the pull request it reads by number (`getGateReason` over `toCommandEvent`: skip
 * labels, skipped authors and targets, with `labels.always_review`), from the default branch rules
 * the sweep loaded, so a pull request the rating would skip spends no dispatch.
 */
export function getSweepChecks(
	pr: PullRequest,
	defaultBranch: string,
	rules: Pick<Rules, 'config'>
): Readonly<Record<'review' | 'converse', boolean>> {
	const converse = passesSweepChecks(pr, defaultBranch)
	const event = toCommandEvent(pr, {
		pullNumber: pr.number,
		base: pr.base.sha,
		head: pr.head.sha,
		depth: undefined,
		agent: undefined,
	})
	return {
		converse,
		review:
			converse && getGateReason(event, rules.config, undefined) === undefined,
	}
}

/**
 * True when the thread check fails the job: it failed, it wrote `error` because the threads could
 * not be read, or a grant may still stand, which the cleanup step then writes over again. A check
 * that wrote nothing or raised to High passes.
 */
export function failsThreadCheck(report: RiskReport | undefined): boolean {
	if (report?.status === 'failed') return true
	return (
		report?.status === 'written' &&
		(report.result.reason === 'thread-read-failed' ||
			report.result.grantStands === true)
	)
}
