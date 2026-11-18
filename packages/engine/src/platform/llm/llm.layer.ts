import { Layer } from 'effect'
import { EndpointConfigLive } from '../config/endpoint.config'
import { LlmServiceLive } from './llm.service'

/**
 * The model service on the endpoint from `MNG_REVIEW_LLM_URL` and `MNG_REVIEW_LLM_KEY`. The caller
 * provides the `HttpClient` (`FetchHttpClient` in the CLI, a scripted one in specs). Building it
 * fails with a `ConfigError` when the URL is missing or malformed.
 */
export const LlmLive = LlmServiceLive.pipe(Layer.provide(EndpointConfigLive))
