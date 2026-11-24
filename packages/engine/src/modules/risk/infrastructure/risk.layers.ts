import { Layer } from 'effect'
import { LlmLive } from '../../../platform/llm/llm.layer'
import { LlmSettings } from '../../../platform/llm/llm.service'
import { ReviewLimits } from '../../review/application/review-limits.context'
import { AgentLoopServiceLive } from '../../review/application/services/agent-loop.service'
import { ModelHealthServiceLive } from '../../review/application/services/model-health.service'
import { RepoToolsServiceLive } from '../../review/application/services/repo-tools.service'
import { FloorDiffServiceLive } from '../application/floor-diff.service'
import { RaterServiceLive } from '../application/rater.service'

/** The rater over its own model-health gate and tool service, without the endpoint. */
export const RaterPipelineLive = RaterServiceLive.pipe(
	Layer.provide(Layer.mergeAll(AgentLoopServiceLive, FloorDiffServiceLive)),
	Layer.provideMerge(
		Layer.mergeAll(ModelHealthServiceLive, RepoToolsServiceLive)
	)
)

/**
 * The rater on the endpoint from `MNG_REVIEW_LLM_URL` and `MNG_REVIEW_LLM_KEY`. It needs the git
 * service, the token ledger and the HTTP client; building it fails with a `ConfigError` when the
 * endpoint is not configured.
 */
export function makeRaterLayer(limits: ReviewLimits['Service']) {
	return RaterPipelineLive.pipe(
		Layer.provide(LlmLive),
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(LlmSettings, { concurrency: limits.concurrency }),
				Layer.succeed(ReviewLimits, limits)
			)
		)
	)
}
