import { Cause, Duration, Predicate, Result, Schema } from 'effect'
import type { AiError } from 'effect/ai'
import { Headers } from 'effect/http'
import { redactText } from '../../utils/redact.util'

/** Reasons worth one more attempt: 429 rate limits and 5xx provider errors. */
const RETRYABLE_REASONS = ['RateLimitError', 'InternalProviderError'] as const
export const TIMEOUT_REASON = 'Timeout'

/** What a model call failed with: an `AiError` from the provider or the call's timeout. */
export type LlmFailure = AiError.AiError | Cause.TimeoutError

/** Endpoint details a message must never carry. */
export interface LlmFailureContext {
	readonly model: string
	readonly secrets: readonly string[]
	readonly timeout: Duration.Input
	/** Current time in epoch milliseconds, to measure a `Retry-After` date. */
	readonly now: number
}

/** The wait a rate limit names, or the `Retry-After` header of a 5xx; an invalid header counts as absent. */
function getRetryAfter(
	reason: AiError.AiErrorReason,
	now: number
): Duration.Duration | undefined {
	if (reason._tag === 'RateLimitError') return reason.retryAfter
	if (reason._tag !== 'InternalProviderError') return undefined
	const header = reason.http?.response?.headers['retry-after']
	if (!Predicate.isString(header)) return undefined
	const parsed = Headers.parseRetryAfter(header)
	return Result.isSuccess(parsed)
		? Headers.retryAfterDelay(parsed.success, now)
		: undefined
}

/**
 * A failed model call. `detail` has the endpoint key, the endpoint address and every URL removed,
 * so the error is safe to print. `reason` is the provider's reason tag (`RateLimitError`,
 * `InternalProviderError`, `InvalidRequestError`, …) or `Timeout`.
 */
export class LlmError extends Schema.TaggedError<LlmError>()('LlmError', {
	model: Schema.String,
	reason: Schema.String,
	detail: Schema.String,
	retryable: Schema.Boolean,
	retryAfterMillis: Schema.optionalKey(Schema.Number),
	status: Schema.optionalKey(Schema.Number),
}) {
	override get message() {
		return `model ${this.model}: ${this.detail}`
	}

	/** Normalises a provider error or a timeout, redacting everything that names the endpoint. */
	static fromFailure(
		failure: LlmFailure,
		context: LlmFailureContext
	): LlmError {
		const { model, secrets } = context
		if (Cause.isTimeoutError(failure))
			return new LlmError({
				model,
				reason: TIMEOUT_REASON,
				detail: `timed out after ${Duration.format(Duration.fromInputUnsafe(context.timeout))}`,
				retryable: false,
			})
		const { reason } = failure
		const status = 'http' in reason ? reason.http?.response?.status : undefined
		const retryAfter = getRetryAfter(reason, context.now)
		return new LlmError({
			model,
			reason: reason._tag,
			detail: redactText(`${reason._tag}: ${reason.message}`, secrets),
			retryable: RETRYABLE_REASONS.some(tag => tag === reason._tag),
			...(retryAfter === undefined
				? {}
				: { retryAfterMillis: Duration.toMillis(retryAfter) }),
			...(Predicate.isNumber(status) ? { status } : {}),
		})
	}
}
