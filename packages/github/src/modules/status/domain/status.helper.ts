import type { CommitState } from '../../../platform/github-status.service'
import type { LenientList } from '../../../platform/list-completeness.context'
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
 * The status the bot's threads stand for now, as the sweep counts them. Open threads, or threads
 * that wait for the owner (`waiting`), make it `failure`; none left makes it `success` only when the
 * last run finished, so an unfinished run stays `error` until a run finishes. Whether it finished
 * comes from the summary's marker when there is one, since a status can be overwritten; else from
 * the status.
 */
export function toSweptStanding(
	previous: PreviousStatus,
	openBugs: number,
	lastRunFinished?: boolean,
	waiting = 0
): CommitStatusText {
	const finished =
		lastRunFinished ??
		(previous.state !== 'error' &&
			!(previous.description ?? '').includes(UNFINISHED_NOTE))
	const verdict = openBugs > 0 ? 'needs fixes' : 'ready'
	return toCommitStatus(
		waiting > 0 ? 'needs owner' : verdict,
		openBugs,
		finished
	)
}

/**
 * The description of a status an incomplete run holds back from `success`: the lists GitHub left
 * an entry out of, so someone can find it, within GitHub's 140 characters.
 */
export function toIncompleteDescription(lists: readonly LenientList[]): string {
	return `a list GitHub returned was incomplete (${lists.join(', ')}); waits for a complete read`
}

/**
 * The status a run whose list reads left a null node out of `lists` writes instead of `next`: a
 * blocking or unfinished one as it is. A `success` becomes `pending` on a head with no status or
 * with `success`, since a thread the run could not see may still block (ADR 0012); over a
 * `pending`, `failure` or `error` the head keeps it (`undefined`).
 */
export function toIncompleteStatus(
	next: CommitStatusText,
	previous: PreviousStatus | undefined,
	lists: readonly LenientList[]
): CommitStatusText | undefined {
	if (next.state !== 'success') return next
	if (previous && previous.state !== 'success') return undefined
	return toHeldStatus({ state: 'success', description: null }, lists)
}

/**
 * The status a run whose list reads left a null node out of `lists` writes when it keeps the head's
 * own: `pending` over a `success`, as `toIncompleteStatus` holds one back; `undefined` otherwise.
 */
export function toHeldStatus(
	previous: PreviousStatus,
	lists: readonly LenientList[]
): CommitStatusText | undefined {
	if (lists.length === 0 || previous.state !== 'success') return undefined
	return { state: 'pending', description: toIncompleteDescription(lists) }
}

/** `next`, or `undefined` when it is missing or says what `previous` says. */
export function toChangedStatus(
	previous: PreviousStatus,
	next: CommitStatusText | undefined
): CommitStatusText | undefined {
	if (
		next?.state === previous.state &&
		next.description === previous.description
	)
		return undefined
	return next
}

/** The status the sweep sets (`toSweptStanding`), or `undefined` when it stays. */
export function toSweptStatus(
	previous: PreviousStatus,
	openBugs: number,
	lastRunFinished?: boolean,
	waiting = 0
): CommitStatusText | undefined {
	return toChangedStatus(
		previous,
		toSweptStanding(previous, openBugs, lastRunFinished, waiting)
	)
}
