import type {
	FeatureMode,
	ReviewConfig,
} from '../../config/review-config.schema'
import type { PullRequestInfo } from '../routing.types'

/** The first pull request label that is in `labels`. */
export function getMatchingLabel(
	pr: PullRequestInfo,
	labels: readonly string[]
): string | undefined {
	return pr.labels.find(label => labels.includes(label))
}

/**
 * Whole-run skip rules. Returns why the run is skipped, or `undefined` to go on. An
 * `labels.always_review` label overrides `skip.drafts` and `skip.labels`, never forks, authors or
 * targets.
 */
export function gateRun(
	config: ReviewConfig,
	pr: PullRequestInfo
): string | undefined {
	if (config.skip.forks && pr.fork) return 'fork pull request (skip.forks)'
	if (pr.author && config.skip.authors.includes(pr.author))
		return `author ${pr.author} is in skip.authors`
	if (pr.target && config.skip.targets.includes(pr.target))
		return `target branch ${pr.target} is in skip.targets`
	if (getMatchingLabel(pr, config.labels.always_review)) return undefined
	if (config.skip.drafts && pr.draft) return 'draft pull request (skip.drafts)'
	const label = getMatchingLabel(pr, config.skip.labels)
	return label ? `label ${label} is in skip.labels` : undefined
}

/** Whether a feature runs; `manual` needs a manual trigger or an `always_review` label. */
export function isFeatureActive(
	mode: FeatureMode,
	config: ReviewConfig,
	pr: PullRequestInfo
): boolean {
	if (mode === 'always') return true
	if (mode === 'off') return false
	return (
		pr.trigger === 'manual' ||
		getMatchingLabel(pr, config.labels.always_review) !== undefined
	)
}
