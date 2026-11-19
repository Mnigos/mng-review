import { Layer } from 'effect'
import { LlmLive } from '../../../platform/llm/llm.layer'
import { LlmSettings } from '../../../platform/llm/llm.service'
import { ReviewLimits } from '../../review/application/review-limits.context'
import { AgentLoopServiceLive } from '../../review/application/services/agent-loop.service'
import { ModelHealthServiceLive } from '../../review/application/services/model-health.service'
import { RepoToolsServiceLive } from '../../review/application/services/repo-tools.service'
import { ValidatorServiceLive } from '../application/validator.service'

/**
 * The validator alone, on the endpoint from `MNG_REVIEW_LLM_URL` and `MNG_REVIEW_LLM_KEY`, with its
 * own model-health gate. It needs the git service, the token ledger and the HTTP client.
 */
export function makeValidatorLayer(limits: ReviewLimits['Service']) {
	return ValidatorServiceLive.pipe(
		Layer.provide(AgentLoopServiceLive),
		Layer.provideMerge(
			Layer.mergeAll(ModelHealthServiceLive, RepoToolsServiceLive)
		),
		Layer.provide(LlmLive),
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(LlmSettings, { concurrency: limits.concurrency }),
				Layer.succeed(ReviewLimits, limits)
			)
		)
	)
}
