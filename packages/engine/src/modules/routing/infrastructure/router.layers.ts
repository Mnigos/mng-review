import { Layer } from 'effect'
import { LlmLive } from '../../../platform/llm/llm.layer'
import { LlmSettings } from '../../../platform/llm/llm.service'
import {
	makeUnavailableRouterLayer,
	RouterServiceLive,
} from '../application/router.service'

/** How the router of one run is built. */
export interface RouterLayerOptions {
	/** `limits.concurrency` from `review.yml`. */
	readonly concurrency: number
	/** Set to skip the model; the router then reports `failed` with this reason. */
	readonly disabledReason?: string
}

/**
 * The router on the endpoint from the environment. Disabled, or without a usable
 * `MNG_REVIEW_LLM_URL`, it reports `failed` with the reason, so the plan still runs on path
 * selection.
 */
export function makeRouterLayer(options: RouterLayerOptions) {
	if (options.disabledReason !== undefined)
		return makeUnavailableRouterLayer(options.disabledReason)
	return RouterServiceLive.pipe(
		Layer.provide(LlmLive),
		Layer.provide(
			Layer.succeed(LlmSettings, { concurrency: options.concurrency })
		),
		Layer.catchTag('ConfigError', error =>
			makeUnavailableRouterLayer(error.message)
		)
	)
}
