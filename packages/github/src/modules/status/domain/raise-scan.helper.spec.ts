import { getScanStride } from './raise-scan.helper'

describe('getScanStride', () => {
	for (const [limit, open, stride] of [
		[20, 257, 20],
		[20, 40, 19],
		[20, 5, 4],
		[20, 1, 1],
		[undefined, 40, 1],
		[1, 40, 1],
	] as const)
		test(`a limit of ${limit} over ${open} open pull requests steps ${stride}`, () => {
			expect(getScanStride(limit, open)).toBe(stride)
		})
	test('every start is visited within as many ticks as there are open pull requests', () => {
		for (const open of [7, 12, 40, 60, 257]) {
			const stride = getScanStride(20, open)
			const starts = new Set(
				Array.from({ length: open }, (_, tick) => (tick * stride) % open)
			)
			expect(starts.size).toBe(open)
		}
	})
})
