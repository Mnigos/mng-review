import { parseAddedRanges, parseEvidenceRef } from './reply-evidence.parser'

describe('parseEvidenceRef', () => {
	test.each([
		['src/money.ts:2', 'src/money.ts', 2, 2],
		['src/money.ts:2-4', 'src/money.ts', 2, 4],
		['  src/money.ts:2-4 uses cents  ', 'src/money.ts', 2, 4],
		['docs/design notes.md:3 explanation', 'docs/design notes.md', 3, 3],
		['./src/../src/money.ts:1', 'src/money.ts', 1, 1],
	] as const)('reads %s', (entry, path, start, end) => {
		expect(parseEvidenceRef(entry)).toEqual({ path, lines: { start, end } })
	})
	test.each([
		'../outside.ts:1',
		'src/../../outside.ts:1',
		'/outside.ts:1',
		'C:\\outside.ts:1',
		'src\\money.ts:1',
		'.:1',
		'src/..:1',
		'src/money.ts:0',
		'src/money.ts:4-2',
		'src/money.ts:2suffix',
		'src/money.ts',
		'',
	])('refuses %s', entry => {
		expect(parseEvidenceRef(entry)).toBeUndefined()
	})
})

describe('parseAddedRanges', () => {
	test('reads single-line and counted hunks, excluding deletion-only hunks', () => {
		expect(
			parseAddedRanges(
				[
					'diff --git a/src/money.ts b/src/money.ts',
					'@@ -1 +2 @@',
					'+new',
					'@@ -8,2 +9,3 @@ context',
					'+new',
					'@@ -15,2 +17,0 @@',
					'-old',
				].join('\n')
			)
		).toEqual([
			{ start: 2, end: 2 },
			{ start: 9, end: 11 },
		])
	})
	test('no hunks add no ranges', () => {
		expect(parseAddedRanges('')).toEqual([])
	})
})
