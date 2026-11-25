/** The greatest common divisor of two whole numbers. */
function getDivisor(first: number, second: number): number {
	return second === 0 ? first : getDivisor(second, first % second)
}

/**
 * How far a raise scan's start moves each run number over `open` pull requests: the largest step no
 * greater than `limit` (one without a limit) that shares no factor with `open`. Such a step visits
 * every start within `open` ticks, so a tick that judges only the pull request at its start still
 * reaches each one, and ticks that make their `limit` judgments cover all within
 * ceil(`open` / step), both while `open` stays the same: an opened or closed one shifts the starts.
 */
export function getScanStride(limit: number | undefined, open: number): number {
	if (open <= 1 || limit === undefined || limit <= 1) return 1
	const largest = Math.min(limit, open)
	const strides = Array.from({ length: largest }, (_, index) => largest - index)
	return strides.find(stride => getDivisor(stride, open) === 1) ?? 1
}
