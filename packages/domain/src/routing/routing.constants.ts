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
