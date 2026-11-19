import type { ConfigError, PullRequestInfo } from '@mng-review/domain'
import type { ReviewReport, Rules } from '@mng-review/engine'
import type { Effect } from 'effect'

/** The pull request a workflow run reviews: its number, the two commits and what the engine sees. */
export interface PullRequestEvent {
	readonly number: number
	readonly baseSha: string
	readonly headSha: string
	readonly pr: PullRequestInfo
}

/** What the workflow entry is given: the event's name and how to read its payload, read only for a pull request event. */
export interface ShadowRunInput {
	readonly eventName: string
	readonly readEvent: Effect.Effect<string, ConfigError>
}

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
