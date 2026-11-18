import { Result } from 'effect'

/** Lines one range may cover; a longer range is cut to this many. */
export const MAX_RANGE_LINES = 2000

/** A 1-based, inclusive line range. */
export interface LineRange {
	readonly start: number
	readonly end: number
}

const RANGE_PATTERN = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/u

/**
 * Parses `40-120` or `40` into a range, its end cut to `MAX_RANGE_LINES` lines after its start. An
 * empty or missing value is no range; anything else that is not a range fails with the reason.
 */
export function parseLineRange(
	value: string | undefined
): Result.Result<LineRange | undefined, string> {
	if (value === undefined || value.trim() === '')
		return Result.succeed(undefined)
	const match = RANGE_PATTERN.exec(value)
	if (!match) return Result.fail('range must look like "40-120"')
	const start = Math.max(1, Number(match[1]))
	const end = match[2] === undefined ? start : Number(match[2])
	if (end < start) return Result.fail('range end is before its start')
	return Result.succeed({
		start,
		end: Math.min(end, start + MAX_RANGE_LINES - 1),
	})
}
