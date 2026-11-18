import { unifiedDiff } from '../shared/mocks/domain-test.helper'
import { budgetDiff, MIN_FILE_DIFF_CHARS } from './diff-budget.helper'

describe('budgetDiff', () => {
	test('keeps every file whole at the exact budget and preserves diff order', () => {
		const blocks = [unifiedDiff('large.ts', 30), unifiedDiff('small.ts')]
		const diff = blocks.join('')
		expect(budgetDiff(diff, diff.length)).toEqual({
			text: diff,
			files: blocks.map((block, index) => ({
				path: index === 0 ? 'large.ts' : 'small.ts',
				chars: block.length,
				shownChars: block.length,
				shown: 'full',
			})),
		})
	})
	test('keeps a one-line change after more than 100k characters whole', () => {
		const large = unifiedDiff('large.ts', 20_000)
		const small = unifiedDiff('small.ts')
		const maxChars = 2 * MIN_FILE_DIFF_CHARS
		const budget = budgetDiff(large + small, maxChars)
		expect(large.length).toBeGreaterThan(100_000)
		expect(budget.text).toContain(small)
		expect(budget.text.endsWith(small)).toBeTruthy()
		expect(budget.files).toEqual([
			{
				path: 'large.ts',
				chars: large.length,
				shownChars: expect.any(Number) as unknown,
				shown: 'cut',
			},
			{
				path: 'small.ts',
				chars: small.length,
				shownChars: small.length,
				shown: 'full',
			},
		])
		expect(budget.text.length).toBeLessThanOrEqual(maxChars)
	})
	test('cuts a huge file on a complete line and counts the omitted characters without losing small files', () => {
		const huge = unifiedDiff('huge.ts', 2000, 'a complete changed line')
		const small = [unifiedDiff('one.ts'), unifiedDiff('two.ts', 2)]
		const maxChars = 3 * MIN_FILE_DIFF_CHARS
		const budget = budgetDiff(huge + small.join(''), maxChars)
		const shownChars = budget.files[0]?.shownChars ?? 0
		expect(shownChars).toBeGreaterThan(0)
		expect(huge[shownChars - 1]).toBe('\n')
		expect(budget.text).toBe(
			`${huge.slice(0, shownChars)}[cut: ${huge.length - shownChars} more characters of this file's diff]\n${small.join('')}`
		)
		expect(budget.files.map(file => file.shown)).toEqual([
			'cut',
			'full',
			'full',
		])
		expect(budget.text.length).toBeLessThanOrEqual(maxChars)
	})
	test('keeps equal small files whole while they fit and names all omitted files', () => {
		const blocks = Array.from({ length: 20 }, (_, index) =>
			unifiedDiff(`file-${String(index).padStart(2, '0')}.ts`)
		)
		const size = blocks[0]?.length ?? 0
		const maxChars = size * 3 + size - 1
		const budget = budgetDiff(blocks.join(''), maxChars)
		expect(Math.floor(maxChars / blocks.length)).toBeLessThan(
			MIN_FILE_DIFF_CHARS
		)
		expect(budget.text).toBe(blocks.slice(0, 3).join(''))
		expect(budget.files).toHaveLength(blocks.length)
		expect(
			budget.files.map(file => [file.chars, file.shownChars, file.shown])
		).toEqual(
			blocks.map((_block, index) => [
				size,
				index < 3 ? size : 0,
				index < 3 ? 'full' : 'none',
			])
		)
		expect(budget.text.length).toBeLessThanOrEqual(maxChars)
	})
	test('an empty diff has no text or file entries', () => {
		expect(budgetDiff('', MIN_FILE_DIFF_CHARS)).toEqual({ text: '', files: [] })
	})
	test('zero budget reports every file as not shown', () => {
		const diff = unifiedDiff('change.ts')
		expect(budgetDiff(diff, 0)).toEqual({
			text: '',
			files: [
				{ path: 'change.ts', chars: diff.length, shownChars: 0, shown: 'none' },
			],
		})
	})
	test('preserves rename-only and deleted-file headers with their correct paths', () => {
		const rename =
			'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n'
		const deleted =
			'diff --git a/deleted.ts b/deleted.ts\ndeleted file mode 100644\n--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n'
		expect(
			budgetDiff(rename + deleted, rename.length + deleted.length)
		).toEqual({
			text: rename + deleted,
			files: [
				{
					path: 'new.ts',
					chars: rename.length,
					shownChars: rename.length,
					shown: 'full',
				},
				{
					path: 'deleted.ts',
					chars: deleted.length,
					shownChars: deleted.length,
					shown: 'full',
				},
			],
		})
	})
})
