import type { ConfigError, PullRequestInfo } from '@mng-review/domain'
import type { ReviewReport, Rules } from '@mng-review/engine'
import type { BotThread, PendingReply } from '@mng-review/github'
import type { Effect } from 'effect'

/** The pull request a workflow run reviews: its number, the two commits and what the engine sees. */
export interface PullRequestEvent {
	/** The event's action, such as `synchronize` or `ready_for_review`. */
	readonly action?: string
	readonly number: number
	readonly baseSha: string
	readonly headSha: string
	readonly pr: PullRequestInfo
}

/** What earlier runs on the pull request left: how many there were and the last head one finished. */
export interface PriorRun {
	readonly runs: number
	readonly head?: string
}

/** What the workflow entry is given: the event's name and how to read its payload, read only for a pull request event. */
export interface ShadowRunInput {
	readonly eventName: string
	readonly readEvent: Effect.Effect<string, ConfigError>
	/**
	 * A command run only: the pull request as read again from the API, used instead of the event
	 * payload, which is the comment's.
	 */
	readonly event?: PullRequestEvent
	/**
	 * The prepare step only: the earlier runs on the pull request, read before any model call, for
	 * `limits.max_runs_per_pr` and incremental input. The rules at the base commit name the bot
	 * identities whose summary counts. Unset or `undefined`: no earlier run is known.
	 */
	readonly readPrior?: (
		event: PullRequestEvent,
		rules: Rules
	) => Effect.Effect<PriorRun | undefined>
	/** The prepare step only: the bot's threads, read once the run goes on. Unset: none. */
	readonly readThreads?: (
		event: PullRequestEvent,
		rules: Rules
	) => Effect.Effect<readonly BotThread[]>
	/** The prepare step only: the authors' replies in those threads worth a decision. Unset: none. */
	readonly readReplies?: (
		event: PullRequestEvent,
		rules: Rules,
		threads: readonly BotThread[],
		prior: PriorRun | undefined
	) => Effect.Effect<readonly PendingReply[]>
}

/** What the review step is told besides the prepared run. */
export interface ReviewOptions {
	/** A declared agent a command named: only it runs. */
	readonly onlyAgent?: string
}

/** The checks before the probe passed; the review step reviews this event. */
export interface ReadyRun {
	readonly status: 'ready'
	readonly event: PullRequestEvent
	readonly prior?: PriorRun
	/** The bot's threads, read with the read token, which the re-check proposes from. */
	readonly threads: readonly BotThread[]
	/** Authors' replies in those threads, read before any model call; none when unset. */
	readonly replies?: readonly PendingReply[]
	/**
	 * The rules the checks loaded, kept only in the process that loaded them; the prepared file
	 * never holds them, so a review step in another process loads them again.
	 */
	readonly rules?: Rules
}

/** What the checks before the probe decided: go on, or the outcome the run ends with. */
export type PreparedRun = ReadyRun | SkippedRun | InvalidConfigRun | FailedRun

/** Nothing was reviewed: not a pull request, a fork, or a `skip` rule at the base commit. */
export interface SkippedRun {
	readonly status: 'skipped'
	readonly reason: string
	readonly event?: PullRequestEvent
}

/** The endpoint did not answer the probe; the run ends neutral. */
export interface OfflineRun {
	readonly status: 'offline'
	readonly reason: string
	readonly event: PullRequestEvent
}

/** The `.mng/` rules at the base commit, or the event, are invalid; `source` names the file or key. */
export interface InvalidConfigRun {
	readonly status: 'invalid-config'
	readonly source: string
	readonly reason: string
	/** Unset when the event itself is invalid. */
	readonly event?: PullRequestEvent
}

/** Git could not read the change, so the workflow's checkout is incomplete. */
export interface FailedRun {
	readonly status: 'failed'
	readonly reason: string
	readonly event: PullRequestEvent
}

/** The change was planned and, unless the plan skipped it, reviewed. */
export interface ReviewedRun {
	readonly status: 'reviewed'
	readonly event: PullRequestEvent
	readonly report: ReviewReport
	/** The rules at the base commit, which publishing applies to the findings. */
	readonly rules: Rules
}

export type ShadowOutcome =
	| SkippedRun
	| OfflineRun
	| InvalidConfigRun
	| FailedRun
	| ReviewedRun
