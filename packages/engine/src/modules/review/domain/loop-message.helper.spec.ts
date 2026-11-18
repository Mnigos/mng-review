import { Response } from 'effect/ai'
import { getCallPath, toContinuationMessage } from './loop-message.helper'
import { MAX_LISTED_UNTOUCHED } from './review.constants'

describe('getCallPath', () => {
	test.each(['read_file', 'diff', 'blame'])(
		'normalizes the path read by %s',
		name => {
			expect(
				getCallPath(
					Response.makePart('tool-call', {
						id: 'read',
						providerExecuted: false,
						name,
						params: { path: './src/./charge.ts' },
					})
				)
			).toBe('src/charge.ts')
		}
	)
	test.each([
		{},
		{ path: 42 },
		{ path: null },
		{ path: '../outside.ts' },
		{ path: '/outside.ts' },
	])('ignores missing or unsafe path %j', params => {
		expect(
			getCallPath(
				Response.makePart('tool-call', {
					id: 'read',
					providerExecuted: false,
					name: 'diff',
					params,
				})
			)
		).toBeUndefined()
	})
})

describe('toContinuationMessage', () => {
	test.each([0, -1, 1, 3])(
		'lists at most the path cap with offset %s',
		offset => {
			const paths = Array.from(
				{ length: MAX_LISTED_UNTOUCHED + offset },
				(_, index) => `src/file-${index}.ts`
			)
			const message = toContinuationMessage(paths, 'report_findings')
			expect(message.split('\n').filter(line => line.startsWith('- '))).toEqual(
				paths.slice(0, MAX_LISTED_UNTOUCHED).map(path => `- ${path}`)
			)
			if (offset > 0) expect(message).toContain(`(and ${offset} more)`)
			else expect(message).not.toContain('(and ')
			expect(message).toContain('findings you already reported are kept')
			expect(message).toContain(
				'call report_findings again with only new findings, or an empty list'
			)
		}
	)
})
