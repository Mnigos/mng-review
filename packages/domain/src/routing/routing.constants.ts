import type { Depth, Risk } from './routing.types'

/** The router's ratings of a change, from the least to the most risky. */
export const RISK_LEVELS = ['trivial', 'normal', 'risky'] as const
/** Run and skip name of the built-in main reviewer. */
export const REVIEWER_NAME = 'reviewer'
export const REVIEWER_TITLE = 'Main reviewer'

/** Depth `auto` follows the risk level. */
export const DEPTH_FOR_RISK = {
	trivial: 'quick',
	normal: 'balanced',
	risky: 'deep',
} as const satisfies Record<Risk, Depth>

/**
 * A mechanical change (a lint or format migration, a rename across the codebase) touches at least
 * this many reviewable files.
 */
export const MECHANICAL_MIN_FILES = 50
/** Most changed lines (added plus removed) of a small edit. */
export const SMALL_EDIT_MAX_LINES = 10
/** Least share of small edits among the files of a mechanical change. */
export const MECHANICAL_MIN_SMALL_SHARE = 0.6
/** Most a mechanical change's added and removed lines may differ, as a share of both. */
export const MECHANICAL_MAX_NET_SHARE = 0.25
/** The conditions a mechanical change meets, in the order `plan` reports them. */
export const MECHANICAL_CONDITIONS = [
	'files',
	'small_share',
	'net_share',
	'risky_rewrite',
] as const
/**
 * Changed lines (added plus removed) from which an edit to a file under `risk_paths` counts as a
 * rewrite. A lint or format migration often touches configuration under `risk_paths` with a few
 * dozen lines; a rewrite of a risky file keeps the change risky.
 */
export const MECHANICAL_REWRITE_MIN_LINES = 50
