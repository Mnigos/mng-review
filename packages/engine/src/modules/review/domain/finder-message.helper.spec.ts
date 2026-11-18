import { MIN_FILE_DIFF_CHARS, type ReviewUnit } from '@mng-review/domain'
import { file, unifiedDiff } from '../../../shared/mocks/domain-test.helper'
import { toChangeMessage, toUnitMessage } from './finder-message.helper'

describe('finder messages', () => {
	test('lists scope, other changed files and skip reasons with their actual line counts', () => {
		const diff = unifiedDiff('scope.ts') + unifiedDiff('other.ts')
		const message = toChangeMessage({
			files: [
				file('scope.ts', { additions: 7, deletions: 2 }),
				file('other.ts'),
				file('skip.ts', { additions: 9, deletions: 0, skipped: 'skip.paths' }),
			],
			scope: ['scope.ts'],
			pr: {},
			diff,
			maxChars: diff.length,
		})
		expect(message).toContain(
			'Files in your scope:\n```text\n- scope.ts (+7 -2)\n```'
		)
		expect(message).toContain(
			'Other changed files:\n```text\n- other.ts (+1 -1)\n- skip.ts (+9 -0, left out of the review (skip.paths))\n```'
		)
		expect(message).toContain(diff)
		expect(message).not.toContain('diff cut')
		expect(message).not.toContain('diff not shown')
		expect(message).not.toContain('Read each one')
	})
	test('marks a cut diff with its shown and original sizes and instructs the finder to read it', () => {
		const diff = unifiedDiff('large.ts', 2000)
		const message = toChangeMessage({
			files: [file('large.ts')],
			scope: ['large.ts'],
			pr: {},
			diff,
			maxChars: MIN_FILE_DIFF_CHARS,
		})
		const cut = /diff cut to (\d+) of (\d+) characters/u.exec(message)
		expect(Number(cut?.[1])).toBeGreaterThan(0)
		expect(Number(cut?.[1])).toBeLessThan(MIN_FILE_DIFF_CHARS)
		expect(Number(cut?.[2])).toBe(diff.length)
		expect(message).toContain('cuts or leaves out 1 of 1 files')
		expect(message).toContain('`diff(path)`')
		expect(message).toContain('before you answer')
	})
	test('names files whose diff gets no budget and tells the finder to read them', () => {
		const files = [file('first.ts'), file('other.ts')]
		const diff = files.map(entry => unifiedDiff(entry.path)).join('')
		const message = toChangeMessage({
			files,
			scope: ['first.ts'],
			pr: {},
			diff,
			maxChars: 0,
		})
		for (const entry of files)
			expect(message).toContain(`- ${entry.path} (+1 -1, diff not shown)`)
		expect(message).toContain('Diff (base to head):\n```text\n(none)\n```')
		expect(message).toContain('cuts or leaves out 2 of 2 files')
		expect(message).toContain('`diff(path)`')
	})
	test.each([0, MIN_FILE_DIFF_CHARS])(
		'deep unit messages identify missing content at budget %i',
		maxChars => {
			const diff = unifiedDiff('unit.ts', 2000)
			const unit = {
				label: 'unit.ts: render()',
				paths: ['unit.ts'],
				diff,
				size: 2001,
			} as const satisfies ReviewUnit
			const message = toUnitMessage({
				files: [file('unit.ts'), file('skip.ts', { skipped: 'binary' })],
				pr: {},
				unit,
				maxChars,
			})
			expect(message).toContain('Your unit:\n```text\nunit.ts: render()\n```')
			expect(message).toContain('All changed files:')
			expect(message).toContain(
				'skip.ts (+1 -1, left out of the review (binary))'
			)
			expect(message).toContain(
				maxChars === 0
					? 'unit.ts (+1 -1, diff not shown)'
					: 'unit.ts (+1 -1, diff cut to '
			)
			expect(message).toContain('Diff of your unit:')
			expect(message).toContain('cuts or leaves out 1 of 1 files')
			expect(message).toContain('`diff(path)`')
		}
	)
	test('empty changes use explicit empty blocks without a missing-content instruction', () => {
		const message = toChangeMessage({
			files: [],
			scope: [],
			pr: {},
			diff: '',
			maxChars: MIN_FILE_DIFF_CHARS,
		})
		expect(message).toContain('Files in your scope:\n```text\n(none)\n```')
		expect(message).toContain('Diff (base to head):\n```text\n(none)\n```')
		expect(message).not.toContain('Other changed files:')
		expect(message).not.toContain('Read each one')
	})
})
