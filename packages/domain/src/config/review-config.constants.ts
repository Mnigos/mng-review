import {
	DEFAULT_REVIEWS_PER_HEAD,
	DEFAULT_RISK_ASSETS,
	DEFAULT_RISK_LABELS,
	VALIDATOR_RISK_MODEL,
} from '../risk/risk.constants'
import type { ReviewConfig } from './review-config.schema'

/** Severities from the least to the most severe; the order ranks findings and floors. */
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const FEATURE_MODES = ['always', 'manual', 'off'] as const
export const DEPTH_SETTINGS = ['auto', 'quick', 'balanced', 'deep'] as const
export const VERDICT_MODES = ['preview', 'approve'] as const
export const CONFIG_PATH = '.mng/review.yml'
/** Notes for the main reviewer and the validator: intentional patterns, where bugs hide. */
export const CONTEXT_PATH = '.mng/CONTEXT.md'
/** Accepted intentional decisions, one line each. */
export const MEMORY_PATH = '.mng/MEMORY.md'
export const DEFAULT_PRESET_NAME = 'mng:default'
/** `models.validator` value that validates a finding on a reviewer model that did not report it. */
export const CROSS_VALIDATOR = 'cross'
/** The slug of the bot the job token posts as, `github-actions[bot]` in REST. */
export const GITHUB_ACTIONS_SLUG = 'github-actions'
/** A GitHub App slug or a bot login without `[bot]`: letters, digits and inner hyphens, at most 39. */
export const BOT_SLUG_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu

/** The `mng:default` preset: every key of `review.yml` has its default here (`docs/spec.md`). */
export const DEFAULT_PRESET = {
	extends: DEFAULT_PRESET_NAME,
	features: { reviewer: 'always', agents: 'always', verdict: 'always' },
	depth: 'auto',
	risk_paths: [],
	comments: { min_severity: 'medium', max_nits: 5, summary: true },
	limits: {
		max_runs_per_pr: 6,
		max_file_kb: 300,
		tokens_per_run: 2_000_000,
		tokens_by_depth: { quick: 100_000, balanced: 300_000, deep: 800_000 },
		tokens_per_pr: 5_000_000,
		concurrency: 4,
	},
	skip: {
		drafts: true,
		forks: true,
		authors: ['dependabot[bot]', 'renovate[bot]'],
		labels: ['skip-review'],
		targets: [],
		paths: [],
	},
	labels: {
		always_review: ['review'],
		depth: { quick: 'mng-review-quick', deep: 'mng-review-deep' },
	},
	commands: { allow: [], max_runs: 3 },
	disputes: { accept_intentional_up_to: 'medium', max_rounds: 1 },
	verdict: { blocking_severity: 'medium', mode: 'approve', never_approve: [] },
	models: {
		router: { model: 'gpt-6-luna', effort: 'low' },
		reviewer: [
			{ model: 'gpt-6.1-sol', effort: 'high' },
			{ model: 'claude-opus-5-5', effort: 'high' },
		],
		agents: { model: 'gpt-6.1-sol', effort: 'high' },
		validator: CROSS_VALIDATOR,
	},
	identity: { previous: [GITHUB_ACTIONS_SLUG] },
	risk: {
		enabled: false,
		labels: DEFAULT_RISK_LABELS,
		floors: [],
		assets: DEFAULT_RISK_ASSETS,
		reviews_per_head: DEFAULT_REVIEWS_PER_HEAD,
		model: VALIDATOR_RISK_MODEL,
	},
} as const satisfies ReviewConfig

/** Presets `extends` may name. */
export const PRESETS = {
	[DEFAULT_PRESET_NAME]: DEFAULT_PRESET,
} as const satisfies Record<string, ReviewConfig>
