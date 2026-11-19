import { Layer } from 'effect'
import { ReviewLimits } from '../../modules/review/application/review-limits.context'
import { AgentLoopServiceLive } from '../../modules/review/application/services/agent-loop.service'
import { ModelHealthServiceLive } from '../../modules/review/application/services/model-health.service'
import { RepoToolsServiceLive } from '../../modules/review/application/services/repo-tools.service'
import { ValidatorServiceLive } from '../../modules/validation/application/validator.service'
import {
	makeScriptedLlmLayer,
	type ScriptedLlmAnswer,
} from '../../platform/llm/scripted-llm.layer'

/** Validator with the production loop and caller's git and ledger, but no endpoint client. */
export function recheckLayer(
	script: ScriptedLlmAnswer,
	limits: ReviewLimits['Service']
) {
	return ValidatorServiceLive.pipe(
		Layer.provide(AgentLoopServiceLive),
		Layer.provideMerge(
			Layer.mergeAll(ModelHealthServiceLive, RepoToolsServiceLive)
		),
		Layer.provide(makeScriptedLlmLayer(script)),
		Layer.provide(Layer.succeed(ReviewLimits, limits))
	)
}
