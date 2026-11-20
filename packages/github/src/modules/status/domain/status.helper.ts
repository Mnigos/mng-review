import type { CommitState } from '../../../platform/github-status.service'
import type { Verdict } from '../../publish/presentation/summary-comment.formatter'

/** What the `MNG Review` status says: its state and a description under GitHub's 140 characters. */
export interface CommitStatusText {
	readonly state: CommitState
	readonly description: string
}

/** Ends the description of a status whose run did not finish, so the sweep never turns it green. */
export const UNFINISHED_NOTE = 'the run did not finish'

/**
 * The status for a verdict: `failure` while confirmed bug threads are open or the verdict is
 * `needs owner`, `error` when the run did not finish and nothing blocks, `success` when ready. A
 * run that did not finish says so in the description, also when bugs block.
 */
export function toCommitStatus(
	verdict: Verdict,
	openBugs: number,
	finished: boolean
): CommitStatusText {
	const note = finished ? '' : `; ${UNFINISHED_NOTE}`
	if (openBugs > 0 || verdict === 'needs owner')
		return {
			state: 'failure',
			description: `${openBugs} open bug thread(s); ${verdict}${note}`,
		}
	if (!finished || verdict === 'incomplete')
		return {
			state: 'error',
			description: `no open bug thread; ${UNFINISHED_NOTE}`,
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
 * it stays. Open threads, or threads that wait for the owner (`waiting`), make it `failure`; none left makes it `success` only when the last run
 * finished, so an unfinished run stays `error` until a run finishes. Whether it finished comes from
 * the summary's marker when there is one, since a status can be overwritten; else from the status.
 */
export function toSweptStatus(
	previous: PreviousStatus,
	openBugs: number,
	lastRunFinished?: boolean,
	waiting = 0
): CommitStatusText | undefined {
	const finished =
		lastRunFinished ??
		(previous.state !== 'error' &&
			!(previous.description ?? '').includes(UNFINISHED_NOTE))
	const verdict = openBugs > 0 ? 'needs fixes' : 'ready'
	const next = toCommitStatus(
		waiting > 0 ? 'needs owner' : verdict,
		openBugs,
		finished
	)
	if (
		next.state === previous.state &&
		next.description === previous.description
	)
		return undefined
	return next
}
