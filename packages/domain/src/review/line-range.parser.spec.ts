import { Result } from 'effect'
import { MAX_RANGE_LINES, parseLineRange } from './line-range.parser'

describe('parseLineRange', () => {
	test.each([undefined, '', '   '])('no range for %s', value => {
		expect(parseLineRange(value)).toEqual(Result.succeed(undefined))
	})
	test.each([
		['2', 2, 2],
		[' 2 - 3 ', 2, 3],
		['0-3', 1, 3],
		['0', 1, 1],
		['3-99999', 3, 3 + MAX_RANGE_LINES - 1],
	] as const)('inclusive range %s', (value, start, end) => {
		expect(parseLineRange(value)).toEqual(Result.succeed({ start, end }))
	})
	test.each(['bad', '3-1', '-1', '1:2', '1.5'])(
		'rejects malformed range %s',
		value => {
			expect(Result.isFailure(parseLineRange(value))).toBeTruthy()
		}
	)
})
