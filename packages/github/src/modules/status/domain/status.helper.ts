import type { CommitState } from '../../../platform/github-status.service'
import type { Verdict } from '../../publish/presentation/summary-comment.formatter'

/** What the `MNG Review` status says: its state and a description under GitHub's 140 characters. */
export interface CommitStatusText {
	readonly state: CommitState
	readonly description: string
}

/**
 * The status for a verdict: `failure` while confirmed bug threads are open, `error` when the run
 * did not finish and nothing blocks, `success` when ready. `needs owner` blocks like open bugs.
 */
export function toCommitStatus(
	verdict: Verdict,
	openBugs: number
): CommitStatusText {
	if (verdict === 'needs fixes' || verdict === 'needs owner')
		return {
			state: 'failure',
			description: `${openBugs} open bug thread(s); ${verdict}`,
		}
	if (verdict === 'incomplete')
		return {
			state: 'error',
			description: 'the review did not finish; no open bug thread so far',
		}
	return { state: 'success', description: 'no open bug thread' }
}

/** The previous status of a head, as the sweep reads it. */
export interface PreviousStatus {
	readonly state: string
	readonly description: string | null
}

/**
 * The status the sweep sets after counting the bot's open bug threads again, or `undefined` when
 * it stays: open threads make it `failure`; none left turns a `failure` into `success`; an `error`
 * (a run that did not finish) stays until a run finishes.
 */
export function toSweptStatus(
	previous: PreviousStatus,
	openBugs: number
): CommitStatusText | undefined {
	const next =
		openBugs > 0
			? toCommitStatus('needs fixes', openBugs)
			: previous.state === 'error'
				? undefined
				: toCommitStatus('ready', 0)
	if (!next) return undefined
	if (
		next.state === previous.state &&
		next.description === previous.description
	)
		return undefined
	return next
}
