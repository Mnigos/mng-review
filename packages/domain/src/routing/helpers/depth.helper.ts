import type { ReviewConfig } from '../../config/review-config.schema'
import { DEPTH_FOR_RISK } from '../routing.constants'
import type { DepthDecision, PullRequestInfo, Risk } from '../routing.types'

/**
 * Picks the depth, first rule first: a change under `risk_paths` is deep, then the deep label, the
 * quick label, a fixed `depth` in `review.yml`, and for `auto` the risk level.
 */
export function resolveDepth(
	config: ReviewConfig,
	pr: PullRequestInfo,
	risk: Risk,
	riskPathHits: readonly string[]
): DepthDecision {
	const { deep, quick } = config.labels.depth
	if (riskPathHits.length > 0) return { depth: 'deep', source: 'risk_paths' }
	if (pr.labels.includes(deep))
		return { depth: 'deep', source: `label ${deep}` }
	if (pr.labels.includes(quick))
		return { depth: 'quick', source: `label ${quick}` }
	if (config.depth !== 'auto')
		return { depth: config.depth, source: 'review.yml depth' }
	return { depth: DEPTH_FOR_RISK[risk], source: `risk ${risk}` }
}
