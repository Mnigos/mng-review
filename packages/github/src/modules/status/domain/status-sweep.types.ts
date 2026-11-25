import type { CommitStatus } from '../../../platform/github-api.schema'
import type { CommitStatusText } from './status.helper'

/** What the sweep did on one pull request. */
export interface SweptPull {
	/** `unknown` when it has no status of the bot. */
	readonly outcome: 'unknown' | 'kept' | 'updated' | 'failed'
	/** The second pass before a raise failed, whatever the status write did. It counts as failed too. */
	readonly readFailed?: boolean
}

/** A pull request whose current identity has two visible old sticky comments and no review. */
export interface DuplicatePull {
	readonly kind: 'duplicate'
	readonly previous: CommitStatus
}

/** A pull request the sweep judged from one pass of reads, before any write. */
export interface JudgedPull {
	readonly kind: 'judged'
	readonly previous: CommitStatus
	readonly standing: CommitStatusText
	/** The newest summary marker is one an incomplete write left (`isIncompleteMarker`). */
	readonly unfinished: boolean
}

/** What one pass over a pull request with a status of the bot judged. */
export type SweptJudgment = DuplicatePull | JudgedPull

/** A pull request whose current identity has two visible old sticky comments and no review. */
export interface DuplicateState {
	readonly kind: 'duplicate'
}

/** What one pass of reads over a pull request found, before the status or a dismissal is decided. */
export interface ReadState {
	readonly kind: 'read'
	/** The current identity's change requests nothing open backs (`getUnbackedRequests`). */
	readonly stale: readonly number[]
	/** Open bug threads, an unsettled answer's included, and bugs without a thread on the head. */
	readonly bugs: number
	/** Threads that wait for the owner and no admin or allowed login cleared. */
	readonly uncleared: number
	/** The newest summary marker is one an incomplete write left (`isIncompleteMarker`). */
	readonly unfinished: boolean
	/** Whether the last full run finished on the head (`getSweptFinished`); `false` while unfinished. */
	readonly finished: boolean | undefined
}

/** What one pass of reads over a pull request found. */
export type PullState = DuplicateState | ReadState
