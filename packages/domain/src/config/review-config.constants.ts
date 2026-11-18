import type { ReviewConfig } from './review-config.schema'

/** Severities from the least to the most severe; the order ranks findings and floors. */
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const FEATURE_MODES = ['always', 'manual', 'off'] as const
export const DEPTH_SETTINGS = ['auto', 'quick', 'balanced', 'deep'] as const
export const VERDICT_MODES = ['preview', 'approve'] as const
export const CONFIG_PATH = '.mng/review.yml'
export const DEFAULT_PRESET_NAME = 'mng:default'
/** `models.validator` value that validates a finding on a reviewer model that did not report it. */
export const CROSS_VALIDATOR = 'cross'

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
		tokens_per_run: 1_500_000,
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
	disputes: { accept_intentional_up_to: 'medium', max_rounds: 1 },
	verdict: { blocking_severity: 'medium', mode: 'preview', never_approve: [] },
	models: {
		router: { model: 'gpt-6-luna', effort: 'low' },
		reviewer: [
			{ model: 'gpt-6.1-sol', effort: 'high' },
			{ model: 'claude-opus-5-5', effort: 'high' },
		],
		agents: { model: 'gpt-6.1-sol', effort: 'high' },
		validator: CROSS_VALIDATOR,
	},
} as const satisfies ReviewConfig

/** Presets `extends` may name. */
export const PRESETS = {
	[DEFAULT_PRESET_NAME]: DEFAULT_PRESET,
} as const satisfies Record<string, ReviewConfig>
