import { DEFAULT_PRESET } from '../../config/review-config.constants'
import { parseFloorDiff } from '../floor-diff.parser'
import { BUILT_IN_FLOOR, GIT_MODE } from '../risk.constants'
import type { FloorDiffFile, FloorSettings } from '../risk.types'
import { getBuiltInFloors, getFloorReport } from './floor.helper'

const SETTINGS = {
	floors: [],
	assets: [],
	rulesPaths: ['policy/risk.md'],
} as const satisfies FloorSettings

/** A regular text change with overridable git metadata. */
function file(
	path: string,
	overrides: Partial<FloorDiffFile> = {}
): FloorDiffFile {
	return {
		path,
		status: 'M',
		oldMode: '100644',
		newMode: '100644',
		count: { added: 2, deleted: 3 },
		...overrides,
	}
}

describe('built-in floors', () => {
	test.each([
		['.github/workflows/x.yml', BUILT_IN_FLOOR.GITHUB],
		['.github/CODEOWNERS', BUILT_IN_FLOOR.GITHUB],
		['.github/dependabot.yml', BUILT_IN_FLOOR.GITHUB],
		['.mng/review.yml', BUILT_IN_FLOOR.MNG],
		['CODEOWNERS', BUILT_IN_FLOOR.CODEOWNERS],
		['docs/CODEOWNERS', BUILT_IN_FLOOR.CODEOWNERS],
		['.gitattributes', BUILT_IN_FLOOR.GITATTRIBUTES],
		['a/b/.gitattributes', BUILT_IN_FLOOR.GITATTRIBUTES],
		['policy/risk.md', BUILT_IN_FLOOR.RULES],
		['.GitHub/x', BUILT_IN_FLOOR.GITHUB],
		['.MNG/x', BUILT_IN_FLOOR.MNG],
		['Docs/CodeOwners', BUILT_IN_FLOOR.CODEOWNERS],
		['a/.GitAttributes', BUILT_IN_FLOOR.GITATTRIBUTES],
		['POLICY/RISK.MD', BUILT_IN_FLOOR.RULES],
	] as const)('%s sets High on add, modify and delete', (path, name) => {
		for (const modes of [
			{ status: 'A', oldMode: GIT_MODE.NONE, newMode: '100644' },
			{ status: 'M', oldMode: '100644', newMode: '100644' },
			{ status: 'D', oldMode: '100644', newMode: GIT_MODE.NONE },
		])
			expect(
				getFloorReport({ intact: true, files: [file(path, modes)] }, SETTINGS)
			).toEqual({
				hits: [
					{
						name,
						level: 'high',
						builtIn: true,
						paths: [path],
						added: 2,
						deleted: 3,
					},
				],
				opaque: [],
			})
	})
	test.each([
		'src/CODEOWNERS',
		'docs/x/CODEOWNERS',
		'.githubx/a',
		'x.gitattributes',
		'.mngx/a',
		'policy/risk.md.bak',
	])('%s does not hit a built-in path floor', path => {
		expect(getBuiltInFloors(file(path), SETTINGS.rulesPaths)).toEqual([])
	})
	test.each([
		[GIT_MODE.GITLINK, GIT_MODE.GITLINK, [BUILT_IN_FLOOR.SUBMODULE]],
		[GIT_MODE.NONE, GIT_MODE.GITLINK, [BUILT_IN_FLOOR.SUBMODULE]],
		[GIT_MODE.GITLINK, GIT_MODE.NONE, [BUILT_IN_FLOOR.SUBMODULE]],
		[GIT_MODE.SYMLINK, GIT_MODE.SYMLINK, [BUILT_IN_FLOOR.SYMLINK]],
		[GIT_MODE.NONE, GIT_MODE.SYMLINK, [BUILT_IN_FLOOR.SYMLINK]],
		[GIT_MODE.SYMLINK, GIT_MODE.NONE, [BUILT_IN_FLOOR.SYMLINK]],
		['100644', '100755', [BUILT_IN_FLOOR.MODE]],
		['100755', '100644', [BUILT_IN_FLOOR.MODE]],
		['100644', GIT_MODE.SYMLINK, [BUILT_IN_FLOOR.SYMLINK, BUILT_IN_FLOOR.MODE]],
	] as const)(
		'recognizes modes %s to %s anywhere',
		(oldMode, newMode, names) => {
			expect(
				getBuiltInFloors(file('src/unrelated', { oldMode, newMode }), [])
			).toEqual(names)
		}
	)
	test('unknown counts set High and contribute no lines', () => {
		expect(
			getFloorReport(
				{ intact: true, files: [file('src/a.ts', { count: 'unknown' })] },
				SETTINGS
			)
		).toEqual({
			hits: [
				{
					name: BUILT_IN_FLOOR.UNKNOWN_COUNT,
					level: 'high',
					builtIn: true,
					paths: ['src/a.ts'],
					added: 0,
					deleted: 0,
				},
			],
			opaque: [],
		})
	})
	test('an incomplete diff adds an unparsed High floor with no paths', () => {
		expect(
			getFloorReport({ intact: false, files: [file('src/a.ts')] }, SETTINGS)
		).toEqual({
			hits: [
				{
					name: BUILT_IN_FLOOR.UNPARSED,
					level: 'high',
					builtIn: true,
					paths: [],
					added: 0,
					deleted: 0,
				},
			],
			opaque: [],
		})
	})
	test('sums the lines of every matching path once per floor', () => {
		expect(
			getFloorReport(
				{
					intact: true,
					files: [
						file('.github/a'),
						file('.github/b', { count: { added: 7, deleted: 1 } }),
					],
				},
				SETTINGS
			).hits
		).toEqual([
			{
				name: BUILT_IN_FLOOR.GITHUB,
				level: 'high',
				builtIn: true,
				paths: ['.github/a', '.github/b'],
				added: 9,
				deleted: 4,
			},
		])
	})
	test('an empty intact change hits no floor', () => {
		expect(getFloorReport({ intact: true, files: [] }, SETTINGS)).toEqual({
			hits: [],
			opaque: [],
		})
	})
})

describe('configured floors and binaries', () => {
	test('respects excludes and levels independently for overlapping floors', () => {
		const files = [
			file('src/a.ts'),
			file('src/generated/b.ts'),
			file('docs/a.md'),
		]
		expect(
			getFloorReport(
				{ intact: true, files },
				{
					...SETTINGS,
					floors: [
						{
							name: 'source',
							paths: ['src/**'],
							exclude: ['src/generated/**'],
							level: 'medium',
						},
						{
							name: 'all-source',
							paths: ['src/**'],
							exclude: [],
							level: 'high',
						},
						{
							name: 'absent',
							paths: ['missing/**'],
							exclude: [],
							level: 'high',
						},
					],
				}
			).hits
		).toEqual([
			{
				name: 'source',
				level: 'medium',
				builtIn: false,
				paths: ['src/a.ts'],
				added: 2,
				deleted: 3,
			},
			{
				name: 'all-source',
				level: 'high',
				builtIn: false,
				paths: ['src/a.ts', 'src/generated/b.ts'],
				added: 4,
				deleted: 6,
			},
		])
	})
	test.each(['R100', 'C075', 'delete-add'])(
		'counts both %s paths against built-in and configured floors',
		status => {
			const output =
				status === 'delete-add'
					? ':100644 000000 abc1234 0000000 D\u0000.github/old\u0000:000000 100644 0000000 abc1234 A\u0000.mng/new\u0000' +
						'0\t3\t.github/old\u0000' +
						'3\t0\t.mng/new\u0000'
					: `:100644 100644 abc1234 def5678 ${status}\u0000.github/old\u0000.mng/new\u00003\t2\t\u0000.github/old\u0000.mng/new\u0000`
			const { hits } = getFloorReport(parseFloorDiff(output), {
				...SETTINGS,
				floors: [
					{
						name: 'both',
						paths: ['.github/**', '.mng/**'],
						exclude: [],
						level: 'medium',
					},
				],
			})
			expect(hits.map(hit => [hit.name, hit.paths])).toEqual([
				[BUILT_IN_FLOOR.GITHUB, ['.github/old']],
				[BUILT_IN_FLOOR.MNG, ['.mng/new']],
				['both', ['.github/old', '.mng/new']],
			])
			expect(hits.find(hit => hit.name === 'both')).toMatchObject(
				status === 'delete-add'
					? { added: 3, deleted: 3 }
					: { added: 6, deleted: 4 }
			)
		}
	)
	test('configured excludes cannot remove a built-in floor', () => {
		expect(
			getFloorReport(
				{ intact: true, files: [file('.github/a')] },
				{
					...SETTINGS,
					floors: [
						{
							name: 'excluded',
							paths: ['**'],
							exclude: ['.github/**'],
							level: 'medium',
						},
					],
				}
			).hits.map(hit => hit.name)
		).toEqual([BUILT_IN_FLOOR.GITHUB])
	})
	test.each(['M', 'D'])(
		'reports opaque %s binaries and leaves allowed assets readable without lines',
		status => {
			expect(
				getFloorReport(
					{
						intact: true,
						files: [
							file('assets/image.png', { count: 'binary', status }),
							file('lib/blob.bin', { count: 'binary', status }),
						],
					},
					{
						...SETTINGS,
						assets: ['*.png'],
						floors: [
							{ name: 'assets', paths: ['**'], exclude: [], level: 'medium' },
						],
					}
				)
			).toEqual({
				hits: [
					{
						name: 'assets',
						level: 'medium',
						builtIn: false,
						paths: ['assets/image.png', 'lib/blob.bin'],
						added: 0,
						deleted: 0,
					},
				],
				opaque: ['lib/blob.bin'],
			})
		}
	)
	test.each(DEFAULT_PRESET.risk.assets)(
		'allows the preset asset %s in a nested directory',
		pattern => {
			expect(
				getFloorReport(
					{
						intact: true,
						files: [
							file(`assets/nested/file${pattern.slice(1)}`, {
								count: 'binary',
							}),
						],
					},
					{ ...SETTINGS, assets: DEFAULT_PRESET.risk.assets }
				).opaque
			).toEqual([])
		}
	)
	test('default assets leave a binary executable opaque', () => {
		expect(
			getFloorReport(
				{ intact: true, files: [file('bin/tool', { count: 'binary' })] },
				{ ...SETTINGS, assets: DEFAULT_PRESET.risk.assets }
			).opaque
		).toEqual(['bin/tool'])
	})
})
