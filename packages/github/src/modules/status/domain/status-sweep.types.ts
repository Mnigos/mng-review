import type { CommitStatus } from '../../../platform/github-api.schema'
import type { DismissalOutcome } from '../../publish/domain/publish.types'
import type { CommitStatusText } from './status.helper'

/** What the sweep did on one pull request. */
export interface SweptPull {
	/** `unknown` when it has no status of the bot. */
	readonly outcome: 'unknown' | 'kept' | 'updated' | 'failed'
	readonly dismissal: DismissalOutcome
	/**
	 * A read before the dismissals failed: the second read before a raise, whatever the status write
	 * did, or the head read after a status update. It counts as failed too.
	 */
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
	/** The current identity's change requests nothing open backs (`getUnbackedRequests`). */
	readonly stale: readonly number[]
	readonly standing: CommitStatusText
	/** The newest summary marker is one an incomplete write left (`isIncompleteMarker`). */
	readonly unfinished: boolean
}

/** What one pass over a pull request with a status of the bot judged. */
export type SweptJudgment = DuplicatePull | JudgedPull
