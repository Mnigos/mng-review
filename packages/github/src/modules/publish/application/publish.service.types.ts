import type { PullRequestInfo } from '@mng-review/domain'
import type { ReviewReport, Rules } from '@mng-review/engine'
import type { Verdict } from '../presentation/summary-comment.formatter'

/** The pull request and commits a publish call is about. */
export interface PublishTarget {
	readonly pullNumber: number
	/** The reviewed head commit; threads are posted on it. */
	readonly head: string
	readonly engineCommit: string | undefined
}

/** A run a `/mng-review` command started. */
export interface CommandRun {
	/** Set when the command named one agent: the run is not a full review. */
	readonly agentOnly: boolean
}

/** A reviewed run to publish on its pull request. */
export interface PublishInput extends PublishTarget {
	readonly command?: CommandRun
	readonly report: ReviewReport
	readonly rules: Rules
	/** What the engine was told about the pull request; the re-check's validators get it too. */
	readonly pr: PullRequestInfo
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
