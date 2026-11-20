import type { EvidenceRef } from '@mng-review/domain'
import { getShownKeys, isRangeRead } from './reply-read.helper'

const REF = {
	path: 'src/policy.ts',
	lines: { start: 2, end: 3 },
} as const satisfies EvidenceRef

/** Shown lines of `REF.path` at the head. */
function toShown(start: number, end: number) {
	return {
		ref: 'head',
		path: REF.path,
		lines: { start, end },
		truncated: false,
	} as const
}

describe('getShownKeys', () => {
	test.each(['head', 'base'] as const)('keys every shown line at %s', ref => {
		expect(getShownKeys({ ...toShown(2, 3), ref })).toEqual([
			`${ref}\u0000src/policy.ts\u00002`,
			`${ref}\u0000src/policy.ts\u00003`,
		])
	})
})

describe('isRangeRead', () => {
	test('requires all inclusive lines in the same path and tree', () => {
		const reads = new Set(getShownKeys(toShown(2, 3)))
		expect(isRangeRead(reads, 'head', REF)).toBe(true)
		expect(isRangeRead(reads, 'base', REF)).toBe(false)
		expect(isRangeRead(reads, 'head', { ...REF, path: 'src/other.ts' })).toBe(
			false
		)
		expect(
			isRangeRead(reads, 'head', { ...REF, lines: { start: 2, end: 4 } })
		).toBe(false)
	})
	test('combines disjoint reads but a missing middle line fails', () => {
		const reads = new Set([
			...getShownKeys(toShown(2, 2)),
			...getShownKeys(toShown(4, 4)),
		])
		expect(
			isRangeRead(reads, 'head', { ...REF, lines: { start: 2, end: 4 } })
		).toBe(false)
		for (const key of getShownKeys(toShown(3, 3))) reads.add(key)
		expect(
			isRangeRead(reads, 'head', { ...REF, lines: { start: 2, end: 4 } })
		).toBe(true)
	})
	test('an empty read set rejects even a huge range immediately', () => {
		expect(
			isRangeRead(new Set(), 'head', {
				...REF,
				lines: { start: 1, end: Number.MAX_SAFE_INTEGER },
			})
		).toBe(false)
	})
})
