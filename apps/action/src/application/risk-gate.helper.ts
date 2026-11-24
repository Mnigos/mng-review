import type { PullRequestInfo, ReviewConfig } from '@mng-review/domain'
import { type BotIdentity, GITHUB_ACTIONS_IDENTITY } from '@mng-review/github'
import type { RiskRunSettings } from '../infrastructure/risk-run.config'

/**
 * Whether a run rates, and the one line it reports when the rules ask for a rating it cannot give.
 */
export type RiskGate =
	| { readonly status: 'on' }
	| { readonly status: 'off' }
	| { readonly status: 'refused'; readonly reason: string }

/** The facts the gate reads: the rules, the token's identity, the settings and the base branch. */
export interface RiskGateInput {
	readonly config: Pick<ReviewConfig, 'risk'>
	readonly identity: BotIdentity
	readonly settings: RiskRunSettings
	readonly pr: Pick<PullRequestInfo, 'target'>
}

/** What the gate reads besides the rules, which a run whose rules did not load lacks. */
export type RiskSettingsInput = Omit<RiskGateInput, 'config'>

/**
 * A run rates only with `risk.enabled`, as the app (`app-slug`) from its environment
 * (`app-environment`), on a pull request into the default branch. The job token never rates: a
 * same-repository pull request can add a workflow that writes as `github-actions[bot]`.
 */
export function getRiskGate(input: RiskGateInput): RiskGate {
	if (!input.config.risk.enabled) return { status: 'off' }
	return getSettingsGate(input)
}

/**
 * The gate as if the rules turned the rating on: a run whose rules did not load fails closed when
 * its settings would rate.
 */
export function getSettingsGate(input: RiskSettingsInput): RiskGate {
	if (
		input.identity.login === GITHUB_ACTIONS_IDENTITY.login ||
		input.settings.environment === ''
	)
		return {
			status: 'refused',
			reason: 'not rated: the risk rating needs app-slug and app-environment',
		}
	if (
		input.settings.defaultBranch === '' ||
		input.pr.target !== input.settings.defaultBranch
	)
		return {
			status: 'refused',
			reason: 'not rated: the pull request is not into the default branch',
		}
	return { status: 'on' }
}
