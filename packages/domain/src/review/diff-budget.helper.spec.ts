import {
	QUOTED_FILE_DIFFS,
	unifiedDiff,
} from '../shared/mocks/domain-test.helper'
import { budgetDiff, MIN_FILE_DIFF_CHARS } from './diff-budget.helper'

describe('budgetDiff', () => {
	test.each(QUOTED_FILE_DIFFS)(
		'reports the unquoted $header path $path',
		({ diff, path }) => {
			expect(budgetDiff(diff, diff.length)).toEqual({
				text: diff,
				files: [
					{ path, chars: diff.length, shownChars: diff.length, shown: 'full' },
				],
			})
		}
	)
	test('uses leftover excerpts for the smallest omitted files after a share below the minimum', () => {
		const blocks = [1800, 1600, 1700].map((size, index) => {
			const header = unifiedDiff(`file-${index}.ts`)
			return header + '+x\n'.repeat(Math.ceil((size - header.length) / 3))
		})
		expect(blocks.every(block => block.length > 1500)).toBeTruthy()
		expect(Math.floor(1500 / blocks.length)).toBeLessThan(MIN_FILE_DIFF_CHARS)
		const budget = budgetDiff(blocks.join(''), 1500)
		expect(budget.files.map(file => file.shown)).toEqual(['none', 'cut', 'cut'])
		expect(budget.files[0]?.shownChars).toBe(0)
		for (const file of budget.files.filter(entry => entry.shown === 'cut')) {
			const marker = `[cut: ${file.chars - file.shownChars} more characters of this file's diff]\n`
			// The marker and up to two characters of line-boundary rounding use the allowance.
			expect(file.shownChars).toBeGreaterThanOrEqual(
				MIN_FILE_DIFF_CHARS - marker.length - 2
			)
			expect(budget.text).toContain(marker)
		}
		expect(budget.text).toBe(
			budget.files
				.map((file, index) =>
					file.shown === 'none'
						? ''
						: `${blocks[index]?.slice(0, file.shownChars)}[cut: ${file.chars - file.shownChars} more characters of this file's diff]\n`
				)
				.join('')
		)
		expect(budget.text.length).toBeLessThanOrEqual(1500)
	})
	test('shows excerpts when 41 file diffs each exceed a 24,000 character budget', () => {
		const maxChars = 24_000
		const blocks = Array.from({ length: 41 }, (_, index) =>
			unifiedDiff(`file-${String(index).padStart(2, '0')}.ts`, 4000)
		)
		expect(blocks.every(block => block.length > maxChars)).toBeTruthy()
		const budget = budgetDiff(blocks.join(''), maxChars)
		expect(budget.text.length).toBeGreaterThan(0)
		expect(budget.text.length).toBeLessThanOrEqual(maxChars)
		expect(budget.files).toHaveLength(blocks.length)
		expect(budget.files.filter(file => file.shown === 'cut')).toHaveLength(
			Math.floor(maxChars / MIN_FILE_DIFF_CHARS)
		)
		expect(budget.files.at(-1)).toMatchObject({
			path: 'file-40.ts',
			shown: 'none',
			shownChars: 0,
		})
	})
	test.each(['full', 'none', 'cut'] as const)(
		'combines repeated type-change paths as %s',
		shown => {
			const deleted =
				'diff --git a/change.ts b/change.ts\ndeleted file mode 100644\n--- a/change.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'
			const added = unifiedDiff('change.ts', 1000).replace(
				'--- a/change.ts',
				'new file mode 100755\n--- /dev/null'
			)
			const diff = deleted + added
			const maxChars =
				shown === 'full' ? diff.length : shown === 'none' ? 0 : deleted.length
			const budget = budgetDiff(diff, maxChars)
			expect(budget.files).toEqual([
				{
					path: 'change.ts',
					chars: diff.length,
					shownChars:
						shown === 'full'
							? diff.length
							: shown === 'none'
								? 0
								: deleted.length,
					shown,
				},
			])
			expect(budget.text).toBe(
				shown === 'full' ? diff : shown === 'none' ? '' : deleted
			)
		}
	)
	test.each([false, true])(
		'sums repeated-path cut characters in diff order, reversed=%s',
		reversed => {
			const small = unifiedDiff('change.ts', 10, 'small change')
			const large = unifiedDiff('change.ts', 1000, 'large change')
			const blocks = reversed ? [large, small] : [small, large]
			const maxChars = 3 * MIN_FILE_DIFF_CHARS
			const partial = budgetDiff(large, maxChars - small.length)
			expect(partial.files[0]?.shown).toBe('cut')
			expect(budgetDiff(blocks.join(''), maxChars)).toEqual({
				text: reversed ? partial.text + small : small + partial.text,
				files: [
					{
						path: 'change.ts',
						chars: small.length + large.length,
						shownChars: small.length + (partial.files[0]?.shownChars ?? 0),
						shown: 'cut',
					},
				],
			})
		}
	)
	test('two cuts of a repeated path sum their shown characters and keep both blocks', () => {
		const blocks = [
			unifiedDiff('change.ts', 1000, 'first'),
			unifiedDiff('change.ts', 1000, 'second'),
		]
		const maxChars = 4 * MIN_FILE_DIFF_CHARS
		const parts = blocks.map(block => budgetDiff(block, maxChars / 2))
		expect(parts.map(part => part.files[0]?.shown)).toEqual(['cut', 'cut'])
		expect(budgetDiff(blocks.join(''), maxChars)).toEqual({
			text: parts.map(part => part.text).join(''),
			files: [
				{
					path: 'change.ts',
					chars: blocks.join('').length,
					shownChars: parts.reduce(
						(sum, part) => sum + (part.files[0]?.shownChars ?? 0),
						0
					),
					shown: 'cut',
				},
			],
		})
	})
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
