import { QUOTED_FILE_DIFFS } from '../shared/mocks/domain-test.helper'
import {
	MAX_REVIEW_UNITS,
	parseFileDiffs,
	splitReviewUnits,
} from './review-unit.parser'

/** A unified file diff with independently named function hunks. */
function diff(path = 'src/charge.ts', count = 2, context = 'charge') {
	return `diff --git a/${path} b/${path}\nindex 123..456 100644\n--- a/${path}\n+++ b/${path}\n${Array.from({ length: count }, (_, index) => `@@ -${index * 20 + 1} +${index * 20 + 1} @@ export function ${context}${index}() {\n-before${index}\n+after${index}\n`).join('')}`
}

describe('parseFileDiffs and splitReviewUnits', () => {
	test.each(QUOTED_FILE_DIFFS)(
		'unquotes $header header for $path',
		({ diff: text, path }) => {
			const files = parseFileDiffs(text)
			expect(files).toHaveLength(1)
			expect(files[0]?.path).toBe(path)
			expect(
				files[0]?.header +
					(files[0]?.hunks.map(hunk => hunk.text).join('') ?? '')
			).toBe(text)
		}
	)
	test('function contexts retain headers and changed-line sizes', () => {
		const text = diff()
		const files = parseFileDiffs(text)
		expect(files).toHaveLength(1)
		expect(files[0]?.hunks.map(hunk => hunk.context)).toEqual([
			'export function charge0() {',
			'export function charge1() {',
		])
		expect(
			files[0]?.header + (files[0]?.hunks.map(hunk => hunk.text).join('') ?? '')
		).toBe(text)
		const units = splitReviewUnits(text)
		expect(units).toHaveLength(2)
		for (const [index, unit] of units.entries()) {
			expect(unit).toMatchObject({
				label: `src/charge.ts: export function charge${index}() {`,
				paths: ['src/charge.ts'],
				size: 2,
			})
			expect(unit.diff).toContain('diff --git')
			expect(unit.diff.match(/^@@/gmu)).toHaveLength(1)
		}
	})
	test('hunks with the same function context form one unit', () => {
		const text = diff().replace('charge1()', 'charge0()')
		expect(splitReviewUnits(text)).toHaveLength(1)
		expect(splitReviewUnits(text)[0]?.size).toBe(4)
		expect(splitReviewUnits(text)[0]?.diff).toBe(text)
	})
	test('context-free hunks remain independent', () => {
		const text = diff().replaceAll(/ export function charge\d\(\) \{/gu, '')
		expect(splitReviewUnits(text)).toHaveLength(2)
		expect(splitReviewUnits(text).map(unit => unit.label)).toEqual([
			'src/charge.ts',
			'src/charge.ts',
		])
	})
	test('too many functions are merged by file before packing', () => {
		const text = diff('src/charge.ts', MAX_REVIEW_UNITS + 2)
		expect(splitReviewUnits(text)).toEqual([
			{
				label: 'src/charge.ts',
				paths: ['src/charge.ts'],
				diff: text,
				size: (MAX_REVIEW_UNITS + 2) * 2,
			},
		])
	})
	test.each([MAX_REVIEW_UNITS, 3])(
		'packs twelve files into %s groups without losing hunks',
		max => {
			const paths = Array.from(
				{ length: 12 },
				(_, index) => `src/file${index}.ts`
			)
			const text = paths.map(path => diff(path, 1)).join('')
			const units = splitReviewUnits(text, max)
			expect(units.length).toBeLessThanOrEqual(max)
			expect(units.length).toBeGreaterThan(0)
			expect(units.flatMap(unit => unit.paths).toSorted()).toEqual(
				paths.toSorted()
			)
			expect(units.reduce((sum, unit) => sum + unit.size, 0)).toBe(24)
			for (const path of paths)
				expect(units.map(unit => unit.diff).join('')).toContain(diff(path, 1))
		}
	)
	test('rename, deletion, binary and mode-only headers survive without invented hunks', () => {
		const text = [
			'diff --git a/old.ts b/new.ts',
			'similarity index 100%',
			'rename from old.ts',
			'rename to new.ts',
			'diff --git a/deleted.ts b/deleted.ts',
			'deleted file mode 100644',
			'--- a/deleted.ts',
			'+++ /dev/null',
			'@@ -1 +0,0 @@',
			'-gone',
			'diff --git a/image.bin b/image.bin',
			'Binary files a/image.bin and b/image.bin differ',
			'diff --git a/script.sh b/script.sh',
			'old mode 100644',
			'new mode 100755',
			'',
		].join('\n')
		const files = parseFileDiffs(text)
		expect(files.map(file => file.path)).toEqual([
			'new.ts',
			'deleted.ts',
			'image.bin',
			'script.sh',
		])
		expect(files[1]?.hunks[0]?.text).toContain('-gone')
		for (const path of ['new.ts', 'image.bin', 'script.sh']) {
			expect(files.find(file => file.path === path)?.hunks).toEqual([])
			expect(
				splitReviewUnits(text).find(unit => unit.paths.includes(path))?.size
			).toBe(0)
		}
		expect(
			splitReviewUnits(text)
				.map(unit => unit.diff)
				.join('')
		).toBe(text)
	})
	test('empty diff has no units', () => {
		expect(parseFileDiffs('')).toEqual([])
		expect(splitReviewUnits('')).toEqual([])
	})
})

describe('neighbouring file groups', () => {
	test('closes a path-ordered group at its rounded-up share of changed lines', () => {
		const entries = [
			['src/alpha/a.ts', 2],
			['src/alpha/b.ts', 1],
			['src/beta/a.ts', 1],
			['src/beta/b.ts', 1],
			['src/beta/c.ts', 2],
		] as const
		const text = entries.map(([path, count]) => diff(path, count)).join('')
		const units = splitReviewUnits(text, 3)
		expect(
			units.map(unit => ({
				label: unit.label,
				paths: unit.paths,
				size: unit.size,
			}))
		).toEqual([
			{
				label: 'src/alpha/ (2 files)',
				paths: ['src/alpha/a.ts', 'src/alpha/b.ts'],
				size: 6,
			},
			{
				label: 'src/beta/ (3 files)',
				paths: ['src/beta/a.ts', 'src/beta/b.ts', 'src/beta/c.ts'],
				size: 8,
			},
		])
		expect(units.map(unit => unit.diff).join('')).toBe(text)
		expect(
			units.flatMap(unit =>
				parseFileDiffs(unit.diff).flatMap(file => file.hunks)
			)
		).toHaveLength(7)
	})
	test('a large file closes its group and later neighbouring files stay in order', () => {
		const entries = [
			['src/alpha/a.ts', 4],
			['src/alpha/b.ts', 1],
			['src/beta/a.ts', 1],
			['src/beta/b.ts', 1],
			['src/gamma/a.ts', 1],
		] as const
		const units = splitReviewUnits(
			entries.map(([path, count]) => diff(path, count)).join(''),
			3
		)
		expect(units.map(unit => unit.paths)).toEqual([
			['src/alpha/a.ts'],
			['src/alpha/b.ts', 'src/beta/a.ts', 'src/beta/b.ts'],
			['src/gamma/a.ts'],
		])
		expect(units.map(unit => unit.label)).toEqual([
			'src/alpha/ (1 files)',
			'src/ (3 files)',
			'src/gamma/ (1 files)',
		])
		expect(units.map(unit => unit.size)).toEqual([8, 6, 2])
	})
	test.each([1, 2, 3])(
		'packing at max %i is deterministic for shuffled file order and keeps each hunk once',
		max => {
			const paths = [
				'src/alpha/a.ts',
				'src/alpha/b.ts',
				'src/beta/a.ts',
				'src/beta/b.ts',
				'src/gamma/a.ts',
				'src/gamma/b.ts',
			]
			const blocks = paths.map((path, index) => diff(path, (index % 3) + 1))
			const expected = splitReviewUnits(blocks.join(''), max)
			for (const shuffled of [
				blocks.toReversed(),
				[blocks[3], blocks[0], blocks[5], blocks[2], blocks[4], blocks[1]],
			])
				expect(splitReviewUnits(shuffled.join(''), max)).toEqual(expected)
			expect(expected.length).toBeLessThanOrEqual(max)
			expect(expected.flatMap(unit => unit.paths)).toEqual(paths)
			expect(expected.map(unit => unit.diff).join('')).toBe(blocks.join(''))
			expect(expected.reduce((sum, unit) => sum + unit.size, 0)).toBe(24)
		}
	)
	test('labels use complete shared directory segments and omit a nonexistent common directory', () => {
		const text = [
			'a.ts',
			'b.ts',
			'src/billing/charge.ts',
			'src/billings/refund.ts',
		]
			.map(path => diff(path, 1))
			.join('')
		expect(splitReviewUnits(text, 2).map(unit => unit.label)).toEqual([
			'2 files',
			'src/ (2 files)',
		])
	})
	test('zero-line files stay in one nonempty group without losing headers', () => {
		const text = Array.from(
			{ length: 4 },
			(_, index) =>
				`diff --git a/src/mode${index}.ts b/src/mode${index}.ts\nold mode 100644\nnew mode 100755\n`
		).join('')
		expect(splitReviewUnits(text, 2)).toEqual([
			{
				label: 'src/ (4 files)',
				paths: Array.from({ length: 4 }, (_, index) => `src/mode${index}.ts`),
				diff: text,
				size: 0,
			},
		])
	})
})
