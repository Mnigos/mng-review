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
/** Bytes of randomness in a nonce: 16 hex characters. */
export const NONCE_BYTES = 8
/** Timeline item types that bring a head and that carry a label change. */
export const TIMELINE_TYPES = {
	COMMIT: 'PullRequestCommit',
	FORCE_PUSH: 'HeadRefForcePushedEvent',
	LABELED: 'LabeledEvent',
	UNLABELED: 'UnlabeledEvent',
} as const
