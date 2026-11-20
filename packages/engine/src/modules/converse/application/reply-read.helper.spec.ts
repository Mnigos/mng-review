import type { EvidenceRef } from '@mng-review/domain'
import { getReadKeys, isRangeRead } from './reply-read.helper'

const REF = {
	path: 'src/policy.ts',
	lines: { start: 2, end: 3 },
} as const satisfies EvidenceRef

describe('getReadKeys', () => {
	test.each(['head', 'base'] as const)(
		'reads only numbered read_file lines at %s and normalizes the path',
		ref => {
			expect(
				getReadKeys(
					{
						name: 'read_file',
						params: { path: './src/policy.ts', ref, range: '1-99' },
					},
					'header\n2| policy\n3| next\n4|\n[truncated: 50 more characters]'
				)
			).toEqual([
				`${ref}\u0000src/policy.ts\u00002`,
				`${ref}\u0000src/policy.ts\u00003`,
			])
		}
	)
	test('read_file defaults to head and does not infer unread lines from the requested range', () => {
		expect(
			getReadKeys(
				{ name: 'read_file', params: { path: 'src/policy.ts', range: '1-99' } },
				'2| policy'
			)
		).toEqual([`head\u0000src/policy.ts\u00002`])
	})
	test.each(['head', 'base'] as const)(
		'reads grep match lines at %s, ignoring headers, malformed paths and context',
		ref => {
			expect(
				getReadKeys(
					{ name: 'grep', params: { ref } },
					'./src/policy.ts:2:policy\nsrc/other.ts:7:match\n../outside.ts:1:escape\nsrc/policy.ts-two-context\n(no matches)'
				)
			).toEqual([
				`${ref}\u0000src/policy.ts\u00002`,
				`${ref}\u0000src/other.ts\u00007`,
			])
		}
	)
	test('blame always records head lines, with optional boundary and filename prefixes', () => {
		expect(
			getReadKeys(
				{ name: 'blame', params: { path: 'src/policy.ts', ref: 'base' } },
				'^abc1234 (Author 2026-01-31  2) policy\nabc1234 old.ts (Author Name 2026-01-31 3) next\nnot blame'
			)
		).toEqual([
			`head\u0000src/policy.ts\u00002`,
			`head\u0000src/policy.ts\u00003`,
		])
	})
	test.each(['read_file', 'grep', 'blame'])(
		'%s error outputs never show lines',
		name => {
			expect(
				getReadKeys(
					{ name, params: { path: REF.path } },
					'error: refused\n2| policy\nsrc/policy.ts:3:policy\nabc1234 (Author 2026-01-31 2) policy'
				)
			).toEqual([])
		}
	)
	test.each(['diff', 'list_dir', 'pr_metadata', 'report_reply'])(
		'%s cannot supply read evidence',
		name => {
			expect(
				getReadKeys(
					{ name, params: { path: REF.path } },
					'2| policy\nsrc/policy.ts:3:policy'
				)
			).toEqual([])
		}
	)
	test.each([{}, { path: 2 }, { path: '../outside.ts' }])(
		'read_file ignores an invalid path %j',
		params => {
			expect(getReadKeys({ name: 'read_file', params }, '2| policy')).toEqual(
				[]
			)
		}
	)
})

describe('isRangeRead', () => {
	test('requires all inclusive lines in the same path and tree', () => {
		const reads = new Set(
			getReadKeys(
				{ name: 'read_file', params: { path: REF.path } },
				'2| policy\n3| next'
			)
		)
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
		const call = { name: 'read_file', params: { path: REF.path } } as const
		const reads = new Set([
			...getReadKeys(call, '2| policy'),
			...getReadKeys(call, '4| last'),
		])
		expect(
			isRangeRead(reads, 'head', { ...REF, lines: { start: 2, end: 4 } })
		).toBe(false)
		for (const key of getReadKeys(call, '3| middle')) reads.add(key)
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
