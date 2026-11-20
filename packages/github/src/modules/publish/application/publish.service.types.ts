import type { ReviewReport, Rules, TokensByModel } from '@mng-review/engine'
import type { RecheckProposal } from '../domain/publish.types'
import type { Verdict } from '../presentation/summary-comment.formatter'

/** The pull request and commits a publish call is about. */
export interface PublishTarget {
	readonly pullNumber: number
	/** The reviewed head commit; threads are posted on it. */
	readonly head: string
	readonly engineCommit: string | undefined
}

/** A reviewed run to publish on its pull request. */
export interface PublishInput extends PublishTarget {
	readonly report: ReviewReport
	readonly rules: Rules
	/** Set when the re-check ran: threads it checked, the ones it proposes to resolve, the tokens. */
	readonly recheck?: PublishRecheck
}

/** What the re-check of the bot's threads left for publishing to apply. */
export interface PublishRecheck {
	readonly checked: number
	readonly proposals: readonly RecheckProposal[]
	/** The job's tokens after the re-check; the summary shows them instead of the review's. */
	readonly tokens: TokensByModel
}

/** A run that did not review, shown in the sticky summary only when there is none yet. */
export interface StatusInput extends PublishTarget {
	readonly status: string
}

/** What a publish run did. */
export interface PublishResult {
	readonly verdict: Verdict
	readonly openBugs: number
	readonly onLine: number
	readonly onFile: number
	readonly inSummary: number
	/** Threads whose write failed with no answer or a server error; whether GitHub stored them is unknown. */
	readonly unposted: number
	readonly repeated: number
	/** Findings found again under threads resolved without a code change since. */
	readonly dismissed: number
	/** Threads of the bot this run checked again, and the ones it resolved. */
	readonly rechecked: number
	readonly resolved: number
	readonly run: number
}
