import type { Config } from './schema.ts'

/** The `mng:default` preset. Every key of `review.yml` has its default here. */
export const defaultPreset: Config = {
  extends: 'mng:default',
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
    reviewer: { model: 'gpt-6.1-sol', effort: 'medium' },
    nits: { model: 'gpt-6.1-terra', effort: 'medium' },
    validator: { model: 'gpt-6.1-sol', effort: 'high' },
    fallback: null,
  },
}

export const presets: Record<string, Config> = { 'mng:default': defaultPreset }
