import { BILLING_PATH } from '../../../shared/mocks/review-test.helper'
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

describe('toContinuationMessage reasons', () => {
	test('names why each file is unread and steers it to every part of its diff', () => {
		const message = toContinuationMessage(
			[
				{ path: BILLING_PATH, reason: 'partial' },
				{ path: 'src/a.ts', reason: 'deletions' },
			],
			'report_findings'
		)
		expect(message).toContain(
			`- ${BILLING_PATH} (only part of its diff came back)`
		)
		expect(message).toContain(
			'- src/a.ts (read with read_file, which never shows the lines the change deletes)'
		)
		expect(message).toContain('with `diff(path)`, every part of it')
		expect(message).toContain('`read_file` does not count for these files')
	})
})
