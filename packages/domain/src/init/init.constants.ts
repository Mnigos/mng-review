import type { AgentInput } from '../agents/agent-front-matter.schema'

export const RULES_DIR = '.mng'
export const MACROSCOPE_DIR = '.macroscope'
export const MACROSCOPE_CORRECTNESS_PATH =
	'.macroscope/correctness/correctness.md'
export const MACROSCOPE_APPROVABILITY_PATH = '.macroscope/approvability.md'
export const MACROSCOPE_AGENTS_DIR = '.macroscope/check-run-agents'
/** Words that make an imported agent a `kind: nit` convention check. */
export const NIT_TOPIC_PATTERN = /\b(?:conventions?|style|styling|hygiene)\b/iu
/** Path segments of documentation folders, for `alwaysApprove` globs that may become `skip.paths`. */
export const DOC_DIR_PATTERN = /^(?:docs?|documentation)$/iu
/** File names of documentation, for the last segment of an `alwaysApprove` glob. */
export const DOC_FILE_PATTERN =
	/(?:\.(?:md|mdx|markdown|txt|rst|adoc)$|^(?:readme|changelog|license|contributing)(?:\.|$))/iu
/** Suffix for an imported agent whose file name is a built-in role or not a valid agent name. */
export const RENAMED_AGENT_SUFFIX = 'agent'

/** How each Macroscope `input` value maps to an agent `input`. */
export const MACROSCOPE_INPUTS = {
	pr_metadata: 'metadata',
	incremental: 'incremental',
	full_diff: 'full_diff',
	code_object: 'full_diff',
} as const satisfies Record<string, AgentInput>

/** Macroscope agent keys that set a model; agents take `models.agents` from `review.yml` instead. */
export const MACROSCOPE_MODEL_KEYS = ['model', 'reasoning'] as const
/** Macroscope agent keys that cap runs or spending; budgets come from `limits` in `review.yml`. */
export const MACROSCOPE_BUDGET_KEY_PATTERN = /^max(?:Runs|Budget)/u
