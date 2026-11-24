import {
	BLOCKING_CONCLUSIONS,
	CALLER_JOB_SEPARATOR,
	DECIDE_FAILURE,
	DECIDE_JOB_PATTERN,
	type DISPATCH_KINDS,
	MAX_DECIDE_FAILURES,
	RISK_JOB_NAMES,
	SWEEP_SOURCE,
	SKIPPED_CONCLUSION,
} from './risk.constants'

/** What a sweep dispatch runs: a full `review` or the converse. */
export type DispatchKind = (typeof DISPATCH_KINDS)[number]

/**
 * What a dispatched run is about: the comment that holds the pull request, at the version the
 * sweep read (its edit time and digest), and the head it ran on.
 */
export interface DispatchKey {
	readonly kind: DispatchKind
	readonly id: number
	/** The first 16 hex characters of the comment's body digest. */
	readonly digest: string
	/** The comment's latest time, or `HEAD_DISPATCH_AT` for an unrated head. */
	readonly at: string
	readonly head: string
}

/** A dispatched run as the sweep reads it: its decide job's key and how its group job ended. */
export interface DispatchedRun {
	readonly key: DispatchKey
	/**
	 * `null` while the run is in flight; otherwise the conclusion GitHub reports for the group job.
	 */
	readonly conclusion: string | null
	/** How the decide job ended; a failed one skipped the group job without deciding. */
	readonly decide?: string | null
}

/** Why the sweep dispatches nothing for a comment, or `dispatch`. */
export type DispatchVerdict =
	| 'dispatch'
	| 'in-flight'
	| 'blocked'
	| 'run-limit'
	| 'checks-failed'

/**
 * The decide job's name for a sweep dispatch, `MNG Review decide sweep <kind> <comment
 * id>@<digest> <edit time> <head>`, which carries the key the runs API does not show, so the sweep
 * reads it from the jobs list.
 */
export function toDecideJobName(key: DispatchKey): string {
	return `${RISK_JOB_NAMES.DECIDE} ${SWEEP_SOURCE} ${key.kind} ${key.id}@${key.digest} ${key.at} ${key.head}`
}

/** The job's own name, without the caller job a reusable workflow puts in front of it. */
function toOwnJobName(name: string): string {
	return name.split(CALLER_JOB_SEPARATOR).at(-1) ?? name
}

/** True when a job carries the fixed name, alone or under its caller job. */
export function isJobNamed(name: string, fixed: string): boolean {
	return toOwnJobName(name) === fixed
}

/** The key a decide job's name carries, or `undefined` for any other name. */
export function parseDecideJobName(name: string): DispatchKey | undefined {
	const match = DECIDE_JOB_PATTERN.exec(toOwnJobName(name))
	const [, kind, id, digest, at, head] = match ?? []
	if (
		(kind !== 'review' && kind !== 'converse') ||
		!id ||
		!digest ||
		!at ||
		!head
	)
		return undefined
	return { kind, id: Number(id), digest, at, head }
}

/**
 * The `workflow_dispatch` inputs of a dispatch: its source, the pull request and the key, which
 * the decide job's name repeats so the next pass can read it back.
 */
export function toDispatchInputs(
	pullNumber: number,
	key: DispatchKey
): Record<string, string> {
	return {
		source: SWEEP_SOURCE,
		number: String(pullNumber),
		kind: key.kind,
		comment: String(key.id),
		version: key.digest,
		edited: key.at,
		head: key.head,
	}
}

/** True when two keys name the same comment version on the same head. */
function isSameKey(first: DispatchKey, second: DispatchKey): boolean {
	return (
		first.kind === second.kind &&
		first.id === second.id &&
		first.digest === second.digest &&
		first.at === second.at &&
		first.head === second.head
	)
}

/** The sweep's own dispatches among `runs` on the head, which the run limit counts. */
export function countHeadDispatches(
	runs: readonly DispatchedRun[],
	head: string
): number {
	return runs.filter(run => run.key.head === head).length
}

/** What the sweep's checks before a dispatch found. */
export interface DispatchCheck {
	readonly key: DispatchKey
	/** Every run the sweep dispatched for this pull request, read from the jobs of each run. */
	readonly runs: readonly DispatchedRun[]
	/**
	 * The pre-model checks a push run makes passed: not a fork, base is default, `.mng/` loads, gate.
	 */
	readonly checksPass: boolean
	readonly maxRuns: number
	/**
	 * The sweep's dispatches on the head since it arrived, from their own read: `runs` may start at a
	 * later comment, and a new comment must not start a fresh budget on the same head.
	 */
	readonly onHead: number
}

/**
 * True when the dispatched runs for one comment version block a repeat: a group job that concluded
 * `failure`, or `skipped` because the decide job refused it, blocks at once; a group job skipped
 * because the decide job failed blocks only from the second such run, so one repeat follows a
 * failed decide job. A group job that failed blocks at once whatever its decide job did.
 */
function isRepeatBlocked(same: readonly DispatchedRun[]): boolean {
	const blocking = same.filter(run =>
		BLOCKING_CONCLUSIONS.some(conclusion => conclusion === run.conclusion)
	)
	const failedDecides = blocking.filter(
		run =>
			run.decide === DECIDE_FAILURE && run.conclusion === SKIPPED_CONCLUSION
	)
	return (
		blocking.length > failedDecides.length ||
		failedDecides.length >= MAX_DECIDE_FAILURES
	)
}

/**
 * The repeat rule and the run limit. A run for the same comment version in flight waits; one whose
 * group job concluded `failure` or `skipped` blocks a repeat (`isRepeatBlocked`), so a broken or
 * refused converse does not run every pass, while a failed decide job allows one repeat;
 * `cancelled` is ignored, and a `success` that did not name the reply does not block. At
 * `limits.max_runs_per_pr` dispatches on the head nothing is dispatched. An edit changes the
 * version, which makes the comment eligible once more.
 */
export function getDispatchVerdict(check: DispatchCheck): DispatchVerdict {
	if (!check.checksPass) return 'checks-failed'
	const same = check.runs.filter(run => isSameKey(run.key, check.key))
	if (same.some(run => run.conclusion === null)) return 'in-flight'
	if (isRepeatBlocked(same)) return 'blocked'
	if (check.onHead >= check.maxRuns) return 'run-limit'
	return 'dispatch'
}
