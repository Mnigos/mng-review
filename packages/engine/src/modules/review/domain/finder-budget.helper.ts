import { MAX_REVIEW_UNITS, type ReviewUnit } from '@mng-review/domain'
import type { AgentRunReport } from './review-report.types'
import {
	CHARS_PER_TOKEN,
	FIRST_MESSAGE_SHARE,
	MAX_VALIDATION_TOKENS,
	MIN_FIRST_DIFF_CHARS,
	MIN_UNIT_TOKENS,
	MIN_VALIDATION_TOKENS,
} from './review.constants'

/**
 * Diff characters a conversation's first message carries: `FIRST_MESSAGE_SHARE` of its tokens,
 * between `MIN_FIRST_DIFF_CHARS` and `maxChars`. The first message is re-sent on every call, so it
 * is the largest cost a conversation has.
 */
export function getFirstDiffChars(
	conversationTokens: number,
	maxChars: number
): number {
	const chars = Math.floor(
		conversationTokens * FIRST_MESSAGE_SHARE * CHARS_PER_TOKEN
	)
	return Math.min(maxChars, Math.max(MIN_FIRST_DIFF_CHARS, chars))
}

/** Units a deep review of `runTokens` splits into: one per `MIN_UNIT_TOKENS`, 1 to `MAX_REVIEW_UNITS`. */
export function getUnitCount(runTokens: number): number {
	const units = Math.floor(runTokens / MIN_UNIT_TOKENS)
	return Math.min(MAX_REVIEW_UNITS, Math.max(1, units))
}

/**
 * Tokens each validation plans to spend: what is left of the run's planned tokens shared by the
 * findings, between `MIN_VALIDATION_TOKENS` and `MAX_VALIDATION_TOKENS`.
 */
export function getValidationTokens(left: number, findings: number): number {
	const share = findings > 0 ? Math.floor(left / findings) : left
	return Math.min(MAX_VALIDATION_TOKENS, Math.max(MIN_VALIDATION_TOKENS, share))
}

/** The units that touch one of `paths`, or every unit without `paths`. */
export function getUnitsToReview(
	units: readonly ReviewUnit[],
	paths: readonly string[] | undefined
): readonly ReviewUnit[] {
	if (!paths) return units
	return units.filter(unit => unit.paths.some(path => paths.includes(path)))
}

/**
 * `incomplete` when the token budget stopped a job, else `failed` when no job answered and one
 * failed, else `ok`.
 */
export function toFinderStatus(
	failedAll: boolean,
	unfinished: number
): AgentRunReport['status'] {
	if (unfinished > 0) return 'incomplete'
	return failedAll ? 'failed' : 'ok'
}
