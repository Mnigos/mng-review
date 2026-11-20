import type { PullRequestEvent, SkippedRun } from './shadow-run.types'

/** The pull request a command reviews, or why its run is skipped. */
export type CommandEventRead =
	| { readonly status: 'ready'; readonly event: PullRequestEvent }
	| SkippedRun

/** Whether the reserve step counted a manual run, and why not. */
export type ReserveDecision =
	| { readonly reserved: true }
	| { readonly reserved: false; readonly reason: string }
