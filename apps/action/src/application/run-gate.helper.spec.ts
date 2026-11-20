import { DEFAULT_PRESET, type ReviewConfig } from '@mng-review/domain'
import { FORK_REASON, getGateReason } from './run-gate.helper'
import type { PriorRun, PullRequestEvent } from './shadow-run.types'

const EVENT = {
	action: 'synchronize',
	pr: { labels: [], draft: false, fork: false, trigger: 'auto' },
} as const satisfies Pick<PullRequestEvent, 'action' | 'pr'>
const CONFIG = {
	...DEFAULT_PRESET,
	skip: { ...DEFAULT_PRESET.skip, labels: ['skip-review'] },
} as const satisfies ReviewConfig
const PRIOR = {
	runs: CONFIG.limits.max_runs_per_pr,
	head: 'previous-head',
} as const satisfies PriorRun
const LIMIT_REASON = `run limit reached: ${PRIOR.runs} of ${CONFIG.limits.max_runs_per_pr} runs on this pull request; a manual command still runs`

interface GateCase {
	readonly name: string
	readonly pr?: Partial<PullRequestEvent['pr']>
	readonly action?: string
	readonly config?: ReviewConfig
	readonly prior?: PriorRun
	readonly reason?: string
}

describe('getGateReason', () => {
	test.each([
		{
			name: 'a fork is blocked even when skip.forks is false',
			pr: { fork: true },
			config: { ...CONFIG, skip: { ...CONFIG.skip, forks: false } },
			reason: FORK_REASON,
		},
		{
			name: 'a fork wins over draft, labels and the run limit',
			pr: {
				fork: true,
				draft: true,
				labels: ['skip-review', ...CONFIG.labels.always_review],
				trigger: 'manual',
			},
			prior: PRIOR,
			reason: FORK_REASON,
		},
		{
			name: 'a draft is blocked when skip.drafts is true',
			pr: { draft: true },
			reason: 'draft pull request (skip.drafts)',
		},
		{
			name: 'a draft goes on when skip.drafts is false',
			pr: { draft: true },
			config: { ...CONFIG, skip: { ...CONFIG.skip, drafts: false } },
		},
		{
			name: 'a skip label is blocked before the run limit',
			pr: { labels: ['skip-review'] },
			prior: PRIOR,
			reason: 'label skip-review is in skip.labels',
		},
		{
			name: 'an always_review label overrides draft and skip labels',
			pr: {
				draft: true,
				labels: ['skip-review', ...CONFIG.labels.always_review],
			},
		},
		{
			name: 'the run limit blocks at the configured count',
			prior: PRIOR,
			reason: LIMIT_REASON,
		},
		{
			name: 'an always_review label does not bypass the run limit',
			pr: { labels: CONFIG.labels.always_review },
			prior: PRIOR,
			reason: LIMIT_REASON,
		},
		{
			name: 'ready_for_review is exempt from the run limit',
			action: 'ready_for_review',
			prior: PRIOR,
		},
		{
			name: 'a manual trigger is exempt from the run limit',
			pr: { trigger: 'manual' },
			prior: PRIOR,
		},
		{
			name: 'a manual trigger still obeys skip rules',
			pr: { trigger: 'manual', labels: ['skip-review'] },
			prior: PRIOR,
			reason: 'label skip-review is in skip.labels',
		},
		{ name: 'a normal pull request goes on' },
		{
			name: 'a pull request below the run limit goes on',
			prior: { ...PRIOR, runs: PRIOR.runs - 1 },
		},
	] satisfies readonly GateCase[])('$name', (scenario: GateCase) => {
		expect(
			getGateReason(
				{
					...EVENT,
					action: scenario.action ?? EVENT.action,
					pr: { ...EVENT.pr, ...scenario.pr },
				},
				scenario.config ?? CONFIG,
				scenario.prior
			)
		).toBe(scenario.reason)
	})
})
