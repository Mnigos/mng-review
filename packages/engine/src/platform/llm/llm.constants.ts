/** Longest wait for one model call, retries counted separately. */
export const LLM_CALL_TIMEOUT = '3 minutes'
/** One more attempt after a 429 or a 5xx; nothing else is retried. */
export const LLM_MAX_RETRIES = 1
/** Wait before the retry when the endpoint sends no usable `Retry-After`. */
export const LLM_RETRY_DELAY_MILLIS = 2000
/** A longer `Retry-After` fails the call instead of waiting. */
export const LLM_MAX_RETRY_AFTER_MILLIS = 30_000
/** Longest wait for the endpoint's model list before a run in CI. */
export const PROBE_TIMEOUT = '10 seconds'
