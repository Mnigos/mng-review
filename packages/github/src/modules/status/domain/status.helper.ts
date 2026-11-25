import { Predicate } from 'effect'
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

/** How the description of a status an incomplete run held back from `success` starts. */
export const INCOMPLETE_STATUS_PREFIX = 'a list GitHub returned was incomplete'

/**
 * The description of a status an incomplete run holds back from `success`: the lists GitHub left
 * an entry out of, so someone can find it, within GitHub's 140 characters.
 */
export function toIncompleteDescription(lists: readonly LenientList[]): string {
	return `${INCOMPLETE_STATUS_PREFIX} (${lists.join(', ')}); waits for a complete read`
}

/**
 * The `pending` a sweep writes over a `success` when its confirming second pass failed: what that
 * pass could not read may block, so it waits for a complete read as an incomplete one does.
 */
export const UNCONFIRMED_STATUS = {
	state: 'pending',
	description: 'a confirming read failed; waits for a complete read',
} as const satisfies CommitStatusText

/**
 * The status a run whose list reads left a null node out of `lists` writes instead of `next`: a
 * blocking or unfinished one as it is. A `success` becomes `pending` on a head with no status or
 * with `success`, since a thread the run could not see may still block (ADR 0012); another
 * incomplete run's `pending` (its description starts with `INCOMPLETE_STATUS_PREFIX`) that names
 * other lists is written again with this run's; over any other `pending`, a `failure` or an
 * `error` the head keeps it (`undefined`).
 */
export function toIncompleteStatus(
	next: CommitStatusText,
	previous: PreviousStatus | undefined,
	lists: readonly LenientList[]
): CommitStatusText | undefined {
	if (next.state !== 'success') return next
	const held = toHeldStatus({ state: 'success', description: null }, lists)
	if (!previous || previous.state === 'success') return held
	if (
		previous.state !== 'pending' ||
		!previous.description?.startsWith(INCOMPLETE_STATUS_PREFIX) ||
		previous.description === held?.description
	)
		return undefined
	return held
}

/**
 * The status a run that judged its standing from a summary marker an incomplete write left
 * (`isIncompleteMarker`) writes instead of `next`: a `failure` as it is; any other only over no
 * status or a `success`, since that marker may miss what set the head's `failure`, `error` or
 * `pending`. Such a standing never finished, so `next` is never `success`.
 */
export function toIncompleteMarkerStatus(
	next: CommitStatusText,
	previous: PreviousStatus | undefined
): CommitStatusText | undefined {
	if (next.state === 'failure' || !previous || previous.state === 'success')
		return next
	return undefined
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

/**
 * The status the sweep writes for the standing its threads give (`standing`): held back from
 * `success` while a list read of the pull request left a node out of `lists` (`toIncompleteStatus`),
 * since a thread it could not see may block, and judged as `toIncompleteMarkerStatus` does when the
 * newest summary marker is one an incomplete write left (`unfinished`), which may miss what set a
 * `failure`; `undefined` when the head keeps the status it has.
 */
export function toNextSweptStatus(
	standing: CommitStatusText,
	previous: PreviousStatus,
	unfinished: boolean,
	lists: readonly LenientList[]
): CommitStatusText | undefined {
	if (unfinished)
		return toChangedStatus(
			previous,
			toIncompleteMarkerStatus(standing, previous)
		)
	return toChangedStatus(
		previous,
		lists.length > 0 ? toIncompleteStatus(standing, previous, lists) : standing
	)
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

/** The commit states from the most blocking to the least, as the sweep lowers a status. */
const LOWERING_ORDER = [
	'failure',
	'error',
	'pending',
	'success',
] as const satisfies readonly CommitState[]

/** Where `state` stands in `LOWERING_ORDER`; one outside it stands below all, so nothing lowers it. */
function getLoweringRank(state: string): number {
	const order: readonly string[] = LOWERING_ORDER
	return order.indexOf(state)
}

/**
 * The status a sweep writes when its two passes differ, or its second pass failed or left a node
 * out: of `candidates` (each pass's plan), the most blocking one that blocks more than the head's
 * status (`current`), never `success`; `undefined` writes nothing. A plan that blocks the same or
 * less, such as an `error` over a `failure`, is a raise and needs passes that agree.
 */
export function toLoweredStatus(
	candidates: readonly (CommitStatusText | undefined)[],
	current: PreviousStatus
): CommitStatusText | undefined {
	const lowering = candidates
		.filter(Predicate.isNotUndefined)
		.filter(
			candidate =>
				candidate.state !== 'success' &&
				getLoweringRank(candidate.state) < getLoweringRank(current.state)
		)
	return lowering.toSorted(
		(first, second) =>
			getLoweringRank(first.state) - getLoweringRank(second.state)
	)[0]
}
