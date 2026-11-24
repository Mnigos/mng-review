import { toContinuationMessage } from './loop-message.helper'
import { MAX_CONTINUATION_PATHS } from './review.constants'

describe('toContinuationMessage', () => {
	test.each([0, -1, 1, 3])(
		'lists at most the path cap with offset %s',
		offset => {
			const files = Array.from(
				{ length: MAX_CONTINUATION_PATHS + offset },
				(_, index) => ({
					path: `src/file-${index}.ts`,
					reason: 'untouched' as const,
				})
			)
			const message = toContinuationMessage(files, 'report_findings')
			expect(message.split('\n').filter(line => line.startsWith('- '))).toEqual(
				files
					.slice(0, MAX_CONTINUATION_PATHS)
					.map(file => `- ${file.path} (not read)`)
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
