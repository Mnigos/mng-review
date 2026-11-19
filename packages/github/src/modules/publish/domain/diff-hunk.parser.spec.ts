import { cleanupRepos, createRepo } from '../../../shared/mocks/git-test.helper'
import { createCommentableLinesFold, parseHunkHeader } from './diff-hunk.parser'

afterEach(cleanupRepos)

describe('parseHunkHeader', () => {
	test.each([
		{
			text: '@@ -2 +3 @@ function',
			header: { oldStart: 2, oldCount: 1, newStart: 3, newCount: 1 },
		},
		{
			text: '@@ -0,0 +1,2 @@',
			header: { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
		},
		{
			text: '@@ -1,8 +3 @@',
			header: { oldStart: 1, oldCount: 8, newStart: 3, newCount: 1 },
		},
		{
			text: '@@ -1 +3,8 @@',
			header: { oldStart: 1, oldCount: 1, newStart: 3, newCount: 8 },
		},
		{ text: 'not a hunk', header: undefined },
	])('$text', row => {
		expect(parseHunkHeader(row.text)).toEqual(row.header)
	})
})

test('folds real multi-file, multi-hunk diffs without confusing added headers or no-newline notices', () => {
	const repo = createRepo()
	const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
	repo.write('src/a.ts', lines.join('\n'))
	repo.write('src/b.ts', 'old\nkeep\nremoved')
	const base = repo.commit()
	repo.write(
		'src/a.ts',
		lines
			.map((line, index) =>
				index === 1 ? '++ b/other.ts' : index === 25 ? 'changed' : line
			)
			.join('\n')
	)
	repo.write('src/b.ts', 'new\nkeep')
	const head = repo.commit()
	const diff = repo.git(
		'diff',
		'--no-ext-diff',
		'--no-textconv',
		'-U1',
		base,
		head
	)
	expect(diff).toContain('+++ b/other.ts')
	expect(diff).toContain('\\ No newline at end of file')
	const fold = createCommentableLinesFold()
	const state = diff.split('\n').reduce(fold.step, fold.initial)
	expect([...(state.lines.get('src/a.ts') ?? [])]).toEqual([
		1, 2, 3, 25, 26, 27,
	])
	expect([...(state.lines.get('src/b.ts') ?? [])]).toEqual([1, 2])
	expect(state.lines.has('other.ts')).toBe(false)
	expect(state.lines.get('src/b.ts')?.has(3)).toBe(false)
	expect(createCommentableLinesFold().initial.lines.size).toBe(0)
})
