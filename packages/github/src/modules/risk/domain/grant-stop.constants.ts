import type { GrantStop } from './risk.types'

/** Stops of the grant that carry a fixed detail. */
export const MARKER_WRITE_STOP = {
	reason: 'publish-failed',
	detail: 'the risk comment could not be updated',
} as const satisfies GrantStop
export const HELD_READ_STOP = {
	reason: 'publish-failed',
	detail: 'the held level could not be read again',
} as const satisfies GrantStop
export const NONCE_LOST_STOP = {
	reason: 'nonce-lost',
	detail: 'another run wrote the newest status',
} as const satisfies GrantStop
export const THREAD_READ_STOP = {
	reason: 'thread-read-failed',
	detail: 'the review threads could not be read again',
} as const satisfies GrantStop
export const NONCE_READ_STOP = {
	reason: 'publish-failed',
	detail: 'the newest status could not be read',
} as const satisfies GrantStop
export const BASE_BRANCH_STOP = {
	reason: 'head-moved',
	detail: 'the pull request is no longer into the default branch',
} as const satisfies GrantStop
export const MARKER_EDITS_STOP = {
	reason: 'publish-failed',
	detail: 'the edit history of the risk comment could not be read',
} as const satisfies GrantStop
export const MARKER_UNSEEN_STOP = {
	reason: 'publish-failed',
	detail: "the risk comment's edit history does not show this run's update",
} as const satisfies GrantStop
export const MARKER_RACE_STOP = {
	reason: 'marker-edited',
	detail: 'someone else edited the risk comment while this run updated it',
} as const satisfies GrantStop
export const THREAD_RAISE_STOP = {
	reason: 'publish-failed',
	detail: 'a confirmed High or Critical bug thread is open again',
} as const satisfies GrantStop
export const MARKER_PARTIAL_STOP = {
	reason: 'publish-failed',
	detail: "the risk comment's edit history did not list every edit it counts",
} as const satisfies GrantStop
export const MARKER_NULL_STOP = {
	reason: 'publish-failed',
	detail: "the risk comment's edit history lists a new edit as a null node",
} as const satisfies GrantStop
