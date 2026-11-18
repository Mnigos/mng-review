import { Layer } from 'effect'
import { LlmLive } from '../../../platform/llm/llm.layer'
import { LlmSettings } from '../../../platform/llm/llm.service'
import { ValidatorServiceLive } from '../../validation/application/validator.service'
import { ReviewLimits } from '../application/review-limits.context'
import { AgentLoopServiceLive } from '../application/services/agent-loop.service'
import { FinderServiceLive } from '../application/services/finder.service'
import { ModelHealthServiceLive } from '../application/services/model-health.service'
import { RepoToolsServiceLive } from '../application/services/repo-tools.service'
import { ReviewServiceLive } from '../application/services/review.service'

/**
 * The review pipeline over one model-health gate and one tool service. It needs the git service,
 * the model service, the token ledger and the run's `ReviewLimits`.
 */
export const ReviewPipelineLive = ReviewServiceLive.pipe(
	Layer.provide(
		Layer.mergeAll(FinderServiceLive, ValidatorServiceLive).pipe(
			Layer.provideMerge(AgentLoopServiceLive),
			Layer.provideMerge(
				Layer.mergeAll(ModelHealthServiceLive, RepoToolsServiceLive)
			)
		)
	)
)

/**
 * The review pipeline on the endpoint from `MNG_REVIEW_LLM_URL` and `MNG_REVIEW_LLM_KEY`. Building
 * it fails with a `ConfigError` when the URL is missing or malformed.
 */
export function makeReviewLayer(limits: ReviewLimits['Service']) {
	return ReviewPipelineLive.pipe(
		Layer.provide(LlmLive),
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(LlmSettings, { concurrency: limits.concurrency }),
				Layer.succeed(ReviewLimits, limits)
			)
		)
	)
}
