import { Layer } from 'effect'
import { LlmLive } from '../../../platform/llm/llm.layer'
import { LlmSettings } from '../../../platform/llm/llm.service'
import { ReviewLimits } from '../../review/application/review-limits.context'
import { AgentLoopServiceLive } from '../../review/application/services/agent-loop.service'
import { ModelHealthServiceLive } from '../../review/application/services/model-health.service'
import { RepoToolsServiceLive } from '../../review/application/services/repo-tools.service'
import { RecheckServiceLive } from '../../validation/application/recheck.service'
import { ReplyEvidenceServiceLive } from '../application/reply-evidence.service'
import { ReplyServiceLive } from '../application/reply.service'

/**
 * The reply service on the endpoint from `MNG_REVIEW_LLM_URL` and `MNG_REVIEW_LLM_KEY`, with its
 * own model-health gate and the validator's re-check. It needs the git service, the token ledger
 * and the HTTP client; building it fails with a `ConfigError` when the endpoint is not configured.
 */
export function makeReplyLayer(limits: ReviewLimits['Service']) {
	return ReplyServiceLive.pipe(
		Layer.provide(AgentLoopServiceLive),
		Layer.provideMerge(
			Layer.mergeAll(ModelHealthServiceLive, RepoToolsServiceLive)
		),
		Layer.provide(Layer.mergeAll(RecheckServiceLive, ReplyEvidenceServiceLive)),
		Layer.provide(LlmLive),
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(LlmSettings, { concurrency: limits.concurrency }),
				Layer.succeed(ReviewLimits, limits)
			)
		)
	)
}
