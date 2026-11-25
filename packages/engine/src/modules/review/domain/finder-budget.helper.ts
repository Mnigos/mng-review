import { MAX_REVIEW_UNITS, type ReviewUnit } from '@mng-review/domain'
import type { AgentRunReport, UnreadFile } from './review-report.types'
import {
	CHARS_PER_TOKEN,
	FIRST_MESSAGE_SHARE,
	MAX_UNIT_DIFF_CHARS,
	MAX_VALIDATION_TOKENS,
	MIN_FIRST_DIFF_CHARS,
	MIN_UNIT_TOKENS,
	MIN_VALIDATION_TOKENS,
	TURN_OUTPUT_TOKENS,
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

/**
 * Units a deep review of `runTokens` over a diff of `diffChars` splits into: one per
 * `MIN_UNIT_TOKENS`, or one per `MAX_UNIT_DIFF_CHARS` of diff when that is more, 1 to
 * `MAX_REVIEW_UNITS`.
 */
export function getUnitCount(runTokens: number, diffChars: number): number {
	const units = Math.max(
		Math.floor(runTokens / MIN_UNIT_TOKENS),
		Math.ceil(diffChars / MAX_UNIT_DIFF_CHARS)
	)
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

/**
 * Tokens a conversation needs to read `readTokens` of tool output in `turns` even turns after a
 * first message of `firstTokens`, then answer, under the loop's rules: every call re-sends the
 * conversation and adds `TURN_OUTPUT_TOKENS` of its own, a reading turn starts only while two more
 * calls fit (`getMissingTokens`), and its outputs must fit before the answer call.
 */
export function getReadingTokens(
	firstTokens: number,
	readTokens: number,
	turns: number
): number {
	const read = Math.ceil(readTokens / Math.max(1, turns))
	const inputs = Array.from(
		{ length: turns + 1 },
		(_, turn) => firstTokens + turn * (read + TURN_OUTPUT_TOKENS)
	)
	const spentBefore = (turn: number) =>
		inputs
			.slice(0, turn)
			.reduce((sum, input) => sum + input + TURN_OUTPUT_TOKENS, 0)
	const reading = inputs
		.slice(0, turns)
		.map(
			(input, turn) =>
				spentBefore(turn) + 2 * (input + TURN_OUTPUT_TOKENS) + read + 1
		)
	return Math.max(spentBefore(turns + 1), ...reading)
}

/** The unread count and files of an agent report, from its conversations' unread files; none when empty. */
export function toUnreadReport(
	files: readonly UnreadFile[]
): Pick<AgentRunReport, 'unread' | 'unreadFiles'> {
	return files.length > 0 ? { unread: files.length, unreadFiles: files } : {}
}

/** The token rates of an agent report, to two decimals; none when empty. */
export function toRateReport(
	rates: readonly number[]
): Pick<AgentRunReport, 'tokenRates'> {
	return rates.length > 0
		? { tokenRates: rates.map(rate => Math.round(rate * 100) / 100) }
		: {}
}

/**
 * The share of what reading every cut file needs (`needed` tokens beyond the conversations' shares)
 * that the run can grant within `room`: 1 when it fits, else the same smaller factor for every
 * conversation, which the run reports as capped.
 */
export function getCoverageScale(needed: number, room: number): number {
	if (needed <= room) return 1
	return Math.max(0, room) / needed
}
