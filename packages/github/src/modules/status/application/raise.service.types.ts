import type { DismissalOutcome } from '../../publish/domain/publish.types'
import type { CommitStatusText } from '../domain/status.helper'

/** The open pull requests with a raise due, and how many were read, failed or left unscanned. */
export interface RaiseFindResult {
	/** Numbers in the order the scan judged them. */
	readonly pulls: readonly number[]
	/** Open pull requests listed. */
	readonly read: number
	readonly failed: number
	/** Open pull requests the scan did not reach before its deadline. */
	readonly unscanned: number
	/** Open pull requests left for later ticks once the scan made its `limit` of full judgments. */
	readonly deferred: number
	/** The pull request whose judgment the scan's `bound` cut; unset when none was cut. */
	readonly dropped?: number
	/** Set when the scan's `bound` ended it: before the listing, between judgments or during one. */
	readonly stop?: 'bound'
}

/** Where a scan starts, and when it stops starting judgments. */
export interface RaiseScan {
	/**
	 * The run number: each tick starts `getScanStride` pull requests further, a step no greater than
	 * `limit` that visits every start, so with N open ones every one is judged within N ticks, and
	 * within ceil(N / step) when ticks make their `limit` judgments, both while N stays the same:
	 * a pull request opened or closed shifts the starts.
	 */
	readonly rotation: number
	/**
	 * `Clock` milliseconds after which no further judgment starts; the first one always does, and a
	 * judgment that started runs to its end. Unset scans until the limit.
	 */
	readonly deadline?: number
	/**
	 * `Clock` milliseconds at which the whole scan ends, its listing included, whatever runs: the
	 * judgments finished by then are kept, and the one in flight is dropped for this tick. Unset
	 * never cuts.
	 */
	readonly bound?: number
	/**
	 * The most full judgments (the reads past the status and the reviews) one scan makes; a pull
	 * request with nothing to raise costs only its two first reads (about 2N a scan over N open
	 * ones) and does not count.
	 */
	readonly limit?: number
}

/**
 * What a raise found on its pull request: `closed` when it is no longer open, `incomplete` when a
 * list read left a node out, `not-due` when nothing would change, `moved` when the head moved
 * before the writes, `changed` when the status changed since the judgment, `raised` when it wrote
 * `success` or dismissed a change request, `updated` when it only rewrote a blocking status, and
 * `refused` when GitHub refused the writes it tried (its status write, or every dismissal) and
 * nothing landed.
 */
export type RaiseOutcome =
	| 'closed'
	| 'incomplete'
	| 'not-due'
	| 'moved'
	| 'changed'
	| 'raised'
	| 'updated'
	| 'refused'

/** What a raise did on one pull request. */
export interface RaiseResult {
	readonly outcome: RaiseOutcome
	/** The pull request's head the raise judged; unset when it is closed. */
	readonly head?: string
	/** The status it wrote; unset when it wrote none. */
	readonly status?: CommitStatusText
	/** Why GitHub refused the status write; the dismissal still ran when it was due. */
	readonly statusError?: string
	readonly dismissal: DismissalOutcome
	/** The head moved between the status write and the dismissal, so every change request stays. */
	readonly movedBeforeDismissal?: true
	/** The pull request closed between the status write and the dismissal; every request stays. */
	readonly closedBeforeDismissal?: true
}
