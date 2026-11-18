import type { Effort } from '../config/review-config.schema'

export const AGENTS_DIR = '.mng/agents'
export const AGENT_KINDS = ['bug', 'nit'] as const
export const AGENT_INPUTS = ['incremental', 'full_diff', 'metadata'] as const
export const DEFAULT_AGENT_INPUT = 'incremental'
export const DEFAULT_MAX_FINDINGS = 8
/** Agent names are file names without `.md`: lowercase letters, digits and dashes. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u
/** Names of built-in roles; a declared agent cannot take them. */
export const RESERVED_AGENT_NAMES = [
	'reviewer',
	'router',
	'validator',
	'verdict',
] as const

/** One step more effort for a deep run, capped at `high`; `xhigh` stays `xhigh`. */
export const RAISED_EFFORT = {
	minimal: 'low',
	low: 'medium',
	medium: 'high',
	high: 'high',
	xhigh: 'xhigh',
} as const satisfies Record<Effort, Effort>
