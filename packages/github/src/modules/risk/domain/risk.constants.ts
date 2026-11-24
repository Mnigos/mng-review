import { Schedule } from 'effect'

/** Rated heads the risk marker keeps; older ones drop off, which only costs a rerun. */
export const MAX_RATED_HEADS = 50
/** The text of the risk comment above its marker. */
export const RISK_MARKER_TEXT =
	'MNG Review keeps the risk rating history of this pull request here. Edits make the pull request unrated.'
/** States of a status that is a real rating, the app history counts. */
export const RATED_STATES = ['success', 'failure'] as const
/** The state the rating's status takes at High. */
export const HIGH_STATE = 'failure'
export const ERROR_STATE = 'error'
/** Reply answers that close a thread; any other answer keeps it open for the thread raise. */
export const CLOSING_REPLY_ACTIONS = ['resolved', 'accepted'] as const
/** The answers the denial job posts: a refused command, or a `review` past the cap. */
export const REFUSAL_KINDS = ['deny', 'cap'] as const
/** Bytes of randomness in a nonce: 16 hex characters. */
export const NONCE_BYTES = 8
/**
 * Reads of the edit history again, and the wait before each, while it does not list the marker
 * update a run just made yet: GitHub can show an edit there a moment after the update answers.
 */
export const EDIT_LAG_RETRIES = 3
export const EDIT_LAG_RETRY = Schedule.spaced('2 seconds')
/** Timeline item types that bring a head and that carry a label change. */
export const TIMELINE_TYPES = {
	COMMIT: 'PullRequestCommit',
	FORCE_PUSH: 'HeadRefForcePushedEvent',
	LABELED: 'LabeledEvent',
	UNLABELED: 'UnlabeledEvent',
	COMMENT: 'IssueComment',
} as const
/**
 * The fixed names of the review workflow's jobs the sweep reads from `actions/runs/<id>/jobs`; the
 * workflows must name their jobs exactly so. `RATING` runs a full rating (push, `review`, the
 * dispatched `review`) and nothing else; `CONVERSE` answers thread replies; `DECIDE` starts the
 * name of a dispatched run's first job, followed by its source and, for the sweep's, its key. A job
 * a reusable workflow runs shows as `<caller job> / <name>`, which counts as the same name.
 */
export const RISK_JOB_NAMES = {
	DECIDE: 'MNG Review decide',
	RATING: 'MNG Review rating',
	CONVERSE: 'MNG Review converse',
} as const
/** What a sweep dispatch asks the review workflow to run. */
export const DISPATCH_KINDS = ['review', 'converse'] as const
/**
 * The `source` a sweep dispatch passes, which its decide job's name repeats: only such a name
 * carries a key, so the bridge's and any other dispatch never counts as the sweep's.
 */
export const SWEEP_SOURCE = 'sweep'
/**
 * `MNG Review decide sweep <kind> <comment id>@<16 hex digest> <edit time or -> <head>`, the name
 * of a dispatched run's decide job when the sweep dispatched it.
 */
export const DECIDE_JOB_PATTERN =
	/^MNG Review decide sweep (review|converse) ([1-9][0-9]{0,15})@([0-9a-f]{16}) (-|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z) ([0-9a-f]{40})$/u
/** What separates the caller job from the called job in a reusable workflow's job name. */
export const CALLER_JOB_SEPARATOR = ' / '
/** Group jobs whose conclusion blocks a repeat dispatch for the same comment version. */
export const BLOCKING_CONCLUSIONS = ['failure', 'skipped'] as const
/** A decide job that failed, which skips the group job without deciding anything. */
export const DECIDE_FAILURE = 'failure'
/** Decide failures for one comment version that block a repeat; one alone allows a repeat. */
export const MAX_DECIDE_FAILURES = 2
/** The run name of every per-pull-request writer, followed by the number. */
export const RISK_RUN_TITLE = 'mng-review-risk-'
/** The run name of the review bridge, followed by the number. */
export const BRIDGE_RUN_TITLE = 'mng-review-bridge-'
/** Run statuses that mean in flight; the runs API filters one per call. */
export const IN_FLIGHT_STATUSES = [
	'queued',
	'pending',
	'requested',
	'waiting',
	'in_progress',
] as const
/** The version a dispatch for an unrated head carries: it names no comment. */
export const HEAD_DISPATCH_VERSION = '0000000000000000'
/** The edit time a dispatch for an unrated head carries. */
export const HEAD_DISPATCH_AT = '-'
/** The conclusion of a job that did not run; a fixed job missing from a completed run counts so. */
export const SKIPPED_CONCLUSION = 'skipped'
/** Conclusions of a full rating run's group job that count as a rating. */
export const RATING_CONCLUSIONS = ['success', 'failure'] as const
/** Events of a default-branch run of the review workflow that can rate, besides a push run. */
export const RATING_EVENTS = ['issue_comment', 'workflow_dispatch'] as const
/** The push run's event; it runs on the pull request's branch and names it in `pull_requests`. */
export const PUSH_EVENT = 'pull_request_target'
/** The event of a run the sweep or the bridge dispatched. */
export const DISPATCH_EVENT = 'workflow_dispatch'
/** Where a run's `path` keeps the workflow file. */
export const WORKFLOWS_DIR = '.github/workflows/'
