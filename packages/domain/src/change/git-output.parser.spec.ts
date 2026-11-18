import { file } from '../shared/mocks/domain-test.helper'
import {
	parseLsTree,
	parseNameStatus,
	parseNumstat,
	toBranchName,
} from './git-output.parser'

test('name-status preserves NUL-delimited names, rename/copy pairs and type changes', () => {
	expect(
		parseNameStatus(
			'A\0new file.ts\0M\0src/auth.ts\0D\0old.ts\0R100\0old name.ts\0new name.ts\0C075\0source.ts\0copy.ts\0T\0link\0U\0conflict\0'
		)
	).toEqual([
		file('new file.ts', {
			status: 'added',
			additions: 0,
			deletions: 0,
			sizeBytes: 0,
		}),
		file('src/auth.ts', { additions: 0, deletions: 0, sizeBytes: 0 }),
		file('old.ts', {
			status: 'deleted',
			additions: 0,
			deletions: 0,
			sizeBytes: 0,
		}),
		file('new name.ts', {
			status: 'renamed',
			oldPath: 'old name.ts',
			additions: 0,
			deletions: 0,
			sizeBytes: 0,
		}),
		file('copy.ts', {
			status: 'copied',
			oldPath: 'source.ts',
			additions: 0,
			deletions: 0,
			sizeBytes: 0,
		}),
		file('link', {
			status: 'type_changed',
			additions: 0,
			deletions: 0,
			sizeBytes: 0,
		}),
		file('conflict', { additions: 0, deletions: 0, sizeBytes: 0 }),
	])
	expect(parseNameStatus('')).toEqual([])
})

test('numstat keeps counts, binary renames, tabs and newlines', () => {
	expect(
		Object.fromEntries(
			parseNumstat(
				'2\t1\tsrc/auth.ts\0' +
					'0\t0\t\0old.ts\0new.ts\0' +
					'-\t-\timage.bin\0' +
					'1\t3\tline\nbreak.ts\0' +
					'1\t2\tsrc/with\ttab.ts\0' +
					'-\t-\t\0old.bin\0new.bin\0'
			)
		)
	).toEqual({
		'src/auth.ts': { additions: 2, deletions: 1, binary: false },
		'new.ts': { additions: 0, deletions: 0, binary: false },
		'image.bin': { additions: 0, deletions: 0, binary: true },
		'line\nbreak.ts': { additions: 1, deletions: 3, binary: false },
		'src/with\ttab.ts': { additions: 1, deletions: 2, binary: false },
		'new.bin': { additions: 0, deletions: 0, binary: true },
	})
	expect(parseNumstat('').size).toBe(0)
})

test('ls-tree splits at the first tab and requires an integer blob size', () => {
	expect(
		parseLsTree(
			'100644 blob abc     6\tline\nwith\ttab.ts\0' +
				'040000 tree def -\tdocs\0' +
				'160000 commit fed -\tsubmodule\0' +
				'100644 blob bad nope\tbad.ts\0' +
				'100644 blob empty 0\tempty.ts\0'
		)
	).toEqual([
		{
			mode: '100644',
			type: 'blob',
			object: 'abc',
			size: 6,
			name: 'line\nwith\ttab.ts',
		},
		{
			mode: '040000',
			type: 'tree',
			object: 'def',
			size: undefined,
			name: 'docs',
		},
		{
			mode: '160000',
			type: 'commit',
			object: 'fed',
			size: undefined,
			name: 'submodule',
		},
		{
			mode: '100644',
			type: 'blob',
			object: 'bad',
			size: undefined,
			name: 'bad.ts',
		},
		{
			mode: '100644',
			type: 'blob',
			object: 'empty',
			size: 0,
			name: 'empty.ts',
		},
	])
	expect(parseLsTree('')).toEqual([])
	expect(parseLsTree('100644 blob abc\tname\tpart\0')[0]?.name).toBe(
		'name\tpart'
	)
})

test.each([
	['refs/heads/main', 'main'],
	['refs/remotes/origin/main', 'main'],
	['refs/remotes/upstream/feature/a', 'feature/a'],
	['refs/tags/v1', undefined],
	['', undefined],
	['abc123', undefined],
	['refs/heads/', undefined],
])('branch name of %s is %s', (ref, expected) => {
	expect(toBranchName(ref)).toBe(expected)
})
