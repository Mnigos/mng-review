import type { Severity } from '@mng-review/domain'

/** The opening of every hidden marker the bot writes; a marker sits alone at the end of a body. */
export const MARKER_PREFIX = 'mng-review:'
export const MARKER_VERSION = 1
/**
 * Characters of a trigger, impact, premise, fix or evidence line a comment keeps, so it stays far
 * below GitHub's 65,536 characters even after escaping and with the marker.
 */
export const MAX_TEXT_CHARS = 3000
/** Characters of a commit SHA shown in comments. */
export const SHORT_SHA_LENGTH = 8
/** Lines either side of a finding where a change since a resolved thread counts as touching its place. */
export const THREAD_PLACE_LINES = 6
/** Open threads the bot checks again in one run, most recently changed first; the rest wait for the next run. */
export const MAX_RECHECKS = 8
/** Threads with an author's reply the bot answers in one run; the rest wait, rotated like the re-check. */
export const MAX_REPLY_THREADS = 8
/** Characters of an author's reply the classifier reads. */
export const MAX_REPLY_CHARS = 4000
/** The label a pull request carries while a thread waits for the owner. */
export const NEEDS_OWNER_LABEL = 'needs-owner'
/**
 * The marker before a bug's severity, the same in its thread, the review body's lists and the check
 * run; nits carry none.
 */
export const SEVERITY_MARKERS = {
	critical: '🔴',
	high: '🟠',
	medium: '🟡',
	low: '🔵',
} as const satisfies Record<Severity, string>
/** The marker of an unverified finding, which never blocks, in place of its severity's marker. */
export const UNVERIFIED_MARKER = '❔'
