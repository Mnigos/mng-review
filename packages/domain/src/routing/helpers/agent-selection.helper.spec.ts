import { agent, file, pr } from '../../shared/mocks/domain-test.helper'
import { selectByRules, getRiskPathHits } from './agent-selection.helper'

describe('selection matrix', () => {
	const files = [
		file('packages/auth/session.ts'),
		file('packages/auth/session.spec.ts'),
		file('src/billing/invoice.ts'),
	]
	test.each([
		[
			{ paths: ['packages/auth/**'] },
			pr(),
			['packages/auth/session.ts', 'packages/auth/session.spec.ts'],
		],
		[
			{ exclude: ['**/*.spec.ts'] },
			pr(),
			['packages/auth/session.ts', 'src/billing/invoice.ts'],
		],
		[
			{ labels: ['security', 'urgent'] },
			pr({ labels: ['urgent'] }),
			files.map(f => f.path),
		],
		[{ authors: ['author-a'] }, pr(), files.map(f => f.path)],
		[{ targets: ['main'] }, pr(), files.map(f => f.path)],
		[{}, pr(), files.map(f => f.path)],
	])('matches each rule independently: %p', (when, info, expected) => {
		expect(selectByRules(agent('auth', { when }), files, info)).toEqual({
			selected: true,
			files: expected,
		})
	})
	for (let mask = 0; mask < 16; mask++) {
		test(`requires every nonempty list to match, bit mask ${mask}`, () => {
			const selection = selectByRules(
				agent('auth', {
					when: {
						paths: [
							Math.floor(mask / 1) % 2 ? 'packages/auth/**' : 'missing/**',
						],
						labels: ['security', 'urgent'],
						authors: ['author-a'],
						targets: ['main'],
						triage: 'ownership changes',
						exclude: ['**/*.spec.ts'],
					},
				}),
				files,
				pr({
					labels: Math.floor(mask / 2) % 2 ? ['urgent'] : [],
					author: Math.floor(mask / 4) % 2 ? 'author-a' : 'author-b',
					target: Math.floor(mask / 8) % 2 ? 'main' : 'release',
				})
			)
			expect(selection.selected).toBe(mask === 15)
			if (mask === 15)
				expect(selection.files).toEqual(['packages/auth/session.ts'])
			if (!selection.selected) expect(selection.routable).toBe(mask === 14)
		})
	}
	test('excluded files cannot satisfy paths and are not offered to the router', () => {
		const selection = selectByRules(
			agent('auth', {
				when: {
					paths: ['packages/auth/**'],
					exclude: ['packages/auth/**'],
					triage: 'ownership changes',
				},
			}),
			files,
			pr()
		)
		expect(selection).toMatchObject({
			selected: false,
			routable: true,
			files: ['src/billing/invoice.ts'],
		})
	})
	test.each(['skip.paths', 'binary', 'too_large'] as const)(
		'skipped files (%s) never match or become candidates',
		skipped => {
			const skippedFiles = [file('packages/auth/session.ts', { skipped })]
			expect(
				selectByRules(
					agent('auth', {
						when: { paths: ['packages/auth/**'], triage: 'ownership' },
					}),
					skippedFiles,
					pr()
				)
			).toMatchObject({ selected: false, routable: false, files: [] })
			expect(selectByRules(agent(), skippedFiles, pr())).toMatchObject({
				selected: false,
				routable: false,
			})
		}
	)
	test('only a paths-only failure with triage and reviewable scope is routable', () => {
		expect(
			selectByRules(
				agent('auth', { when: { paths: ['other/**'] } }),
				files,
				pr()
			)
		).toMatchObject({ selected: false, routable: false })
		expect(
			selectByRules(
				agent('auth', { when: { paths: ['other/**'], triage: 'ownership' } }),
				[],
				pr()
			)
		).toMatchObject({ selected: false, routable: false })
		expect(
			selectByRules(
				agent('auth', { when: { paths: ['other/**'], triage: 'ownership' } }),
				files,
				pr()
			)
		).toMatchObject({
			selected: false,
			routable: true,
			files: files.map(f => f.path),
		})
	})
	test('metadata with no paths runs without reviewable files, but other inputs and explicit paths do not', () => {
		const empty = [file('ignored.ts', { skipped: 'skip.paths' })]
		expect(
			selectByRules(agent('meta', { input: 'metadata' }), empty, pr())
		).toEqual({
			selected: true,
			files: [],
		})
		expect(
			selectByRules(
				agent('meta', { input: 'metadata', when: { labels: ['urgent'] } }),
				empty,
				pr()
			)
		).toMatchObject({ selected: false, routable: false })
		expect(
			selectByRules(
				agent('meta', { input: 'metadata', when: { paths: ['ignored.ts'] } }),
				empty,
				pr()
			)
		).toMatchObject({ selected: false, routable: false })
		expect(
			selectByRules(agent('auth', { input: 'full_diff' }), empty, pr())
		).toMatchObject({
			selected: false,
			routable: false,
		})
	})
	test('absent author/target cannot satisfy a nonempty list', () => {
		expect(
			selectByRules(
				agent('auth', { when: { authors: ['author-a'] } }),
				files,
				pr({ author: undefined })
			).selected
		).toBe(false)
		expect(
			selectByRules(
				agent('auth', { when: { targets: ['main'] } }),
				files,
				pr({ target: undefined })
			).selected
		).toBe(false)
	})
	test.each(['src/auth/session.ts', 'src/session.ts'])(
		'renamed files match when.paths at %s and report the new path',
		path => {
			const renamedFiles = [
				file('src/session.ts', {
					status: 'renamed',
					oldPath: 'src/auth/session.ts',
				}),
			]
			expect(
				selectByRules(
					agent('auth', { when: { paths: [path] } }),
					renamedFiles,
					pr()
				)
			).toEqual({
				selected: true,
				files: ['src/session.ts'],
			})
		}
	)
	test.each([
		['src/auth/**', true],
		['src/session.ts', false],
	] as const)(
		'rename exclusion %s applies only to the new path',
		(exclude, selected) => {
			const selection = selectByRules(
				agent('auth', { when: { paths: ['src/auth/**'], exclude: [exclude] } }),
				[
					file('src/session.ts', {
						status: 'renamed',
						oldPath: 'src/auth/session.ts',
					}),
				],
				pr()
			)
			expect(selection).toMatchObject({
				selected,
				files: selected ? ['src/session.ts'] : [],
			})
		}
	)
	test('skipped renamed files cannot satisfy old path rules or risk paths', () => {
		const renamedFiles = [
			file('src/session.ts', {
				status: 'renamed',
				oldPath: 'src/auth/session.ts',
				skipped: 'binary',
			}),
		]
		expect(
			selectByRules(
				agent('auth', { when: { paths: ['src/auth/**'] } }),
				renamedFiles,
				pr()
			)
		).toMatchObject({ selected: false, routable: false, files: [] })
		expect(getRiskPathHits(renamedFiles, ['src/auth/**'])).toEqual([])
	})
	test.each([
		{ patterns: ['src/auth/**'] },
		{ patterns: ['src/session.ts'] },
		{ patterns: ['src/auth/**', 'src/session.ts'] },
	])(
		'renamed files match risk paths %p and report the new path once',
		({ patterns }) => {
			expect(
				getRiskPathHits(
					[
						file('src/session.ts', {
							status: 'renamed',
							oldPath: 'src/auth/session.ts',
						}),
					],
					patterns
				)
			).toEqual(['src/session.ts'])
		}
	)
	test('riskPathHits includes only reviewable matching files', () => {
		expect(
			getRiskPathHits(
				[...files, file('packages/auth/ignored.ts', { skipped: 'binary' })],
				['packages/auth/**']
			)
		).toEqual(['packages/auth/session.ts', 'packages/auth/session.spec.ts'])
		expect(getRiskPathHits(files, [])).toEqual([])
	})
})
