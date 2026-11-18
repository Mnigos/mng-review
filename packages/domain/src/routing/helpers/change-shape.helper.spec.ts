import {
	file,
	mechanicalFiles,
	featureFiles,
} from '../../shared/mocks/domain-test.helper'
import {
	MECHANICAL_CONDITIONS,
	MECHANICAL_REWRITE_MIN_LINES,
	MECHANICAL_MIN_FILES,
	MECHANICAL_MIN_SMALL_SHARE,
	MECHANICAL_MAX_NET_SHARE,
	SMALL_EDIT_MAX_LINES,
} from '../routing.constants'
import { getChangeShape, isMechanicalChange } from './change-shape.helper'

/** Balanced file edits isolate the small-edit share from the net-change ratio. */
function edits(small: number, count = MECHANICAL_MIN_FILES) {
	return Array.from({ length: count }, (_, index) =>
		file(
			`src/file-${index}.ts`,
			index < small
				? {
						additions: SMALL_EDIT_MAX_LINES / 2,
						deletions: SMALL_EDIT_MAX_LINES / 2,
					}
				: { additions: SMALL_EDIT_MAX_LINES, deletions: SMALL_EDIT_MAX_LINES }
		)
	)
}

describe('mechanical changes', () => {
	test('recognizes the neutral lint fixture and preserves its aggregate shape', () => {
		const files = mechanicalFiles()
		const hits = files
			.filter(entry => entry.path.startsWith('src/billing/'))
			.map(entry => entry.path)
		expect(files).toHaveLength(588)
		expect(files.reduce((sum, entry) => sum + entry.additions, 0)).toBe(5325)
		expect(files.reduce((sum, entry) => sum + entry.deletions, 0)).toBe(4746)
		expect(hits).toHaveLength(22)
		expect(isMechanicalChange(files, hits)).toBe(true)
	})
	test('rejects the neutral feature fixture', () => {
		const files = featureFiles()
		expect(files).toHaveLength(42)
		expect(files.reduce((sum, entry) => sum + entry.additions, 0)).toBe(3286)
		expect(files.reduce((sum, entry) => sum + entry.deletions, 0)).toBe(702)
		expect(
			isMechanicalChange(
				files,
				files.map(entry => entry.path)
			)
		).toBe(false)
	})
	test('requires the minimum reviewable file count', () => {
		expect(isMechanicalChange(edits(MECHANICAL_MIN_FILES), [])).toBe(true)
		expect(isMechanicalChange(edits(MECHANICAL_MIN_FILES).slice(1), [])).toBe(
			false
		)
		expect(isMechanicalChange([], [])).toBe(false)
	})
	test('skipped files do not supply the minimum count or affect net totals', () => {
		const files = edits(MECHANICAL_MIN_FILES)
		expect(
			isMechanicalChange(
				files.map((entry, index) =>
					index === 0 ? { ...entry, skipped: 'too_large' as const } : entry
				),
				[]
			)
		).toBe(false)
		expect(
			isMechanicalChange(
				[
					...files,
					file('generated.ts', {
						skipped: 'skip.paths',
						additions: 100_000,
						deletions: 0,
					}),
				],
				['generated.ts']
			)
		).toBe(true)
	})
	test('includes the small-edit share boundary and rejects one fewer small file', () => {
		const minimum = MECHANICAL_MIN_FILES * MECHANICAL_MIN_SMALL_SHARE
		expect(isMechanicalChange(edits(minimum), [])).toBe(true)
		expect(isMechanicalChange(edits(minimum - 1), [])).toBe(false)
	})
	test('one line above the small-edit boundary no longer counts as a small file', () => {
		const minimum = MECHANICAL_MIN_FILES * MECHANICAL_MIN_SMALL_SHARE
		const files = edits(minimum)
		expect(isMechanicalChange(files, [])).toBe(true)
		expect(
			isMechanicalChange(
				files.map((entry, index) =>
					index === 0
						? { ...entry, additions: SMALL_EDIT_MAX_LINES / 2 + 1 }
						: entry
				),
				[]
			)
		).toBe(false)
	})

	test.each([
		SMALL_EDIT_MAX_LINES + 1,
		MECHANICAL_REWRITE_MIN_LINES - 1,
		MECHANICAL_REWRITE_MIN_LINES,
	])(
		'a risky edit of %i lines breaks shape only at the rewrite boundary',
		lines => {
			const files = [
				...edits(MECHANICAL_MIN_FILES),
				file('config.ts', {
					additions: Math.ceil(lines / 2),
					deletions: Math.floor(lines / 2),
				}),
			]
			const rewritten = lines >= MECHANICAL_REWRITE_MIN_LINES
			expect(getChangeShape(files, ['config.ts'])).toEqual({
				files: files.length,
				smallShare: MECHANICAL_MIN_FILES / files.length,
				netShare:
					(lines % 2) / (MECHANICAL_MIN_FILES * SMALL_EDIT_MAX_LINES + lines),
				riskyRewrites: rewritten ? ['config.ts'] : [],
				failed: rewritten ? ['risky_rewrite'] : [],
			})
			expect(isMechanicalChange(files, ['config.ts'])).toBe(!rewritten)
		}
	)
	test('fifty small risky edits cannot hide one balanced risky rewrite', () => {
		const files = [
			...edits(MECHANICAL_MIN_FILES),
			file('src/billing/rewrite.ts', { additions: 1000, deletions: 1000 }),
		]
		expect(
			isMechanicalChange(
				files,
				files.slice(0, -1).map(entry => entry.path)
			)
		).toBe(true)
		expect(
			isMechanicalChange(
				files,
				files.map(entry => entry.path)
			)
		).toBe(false)
	})
	test('includes the net-share boundary in either direction and rejects exceeding it', () => {
		const total = 400
		const added = (total * (1 + MECHANICAL_MAX_NET_SHARE)) / 2
		const removed = total - added
		const rest = Array.from({ length: MECHANICAL_MIN_FILES - 1 }, (_, index) =>
			file(`empty-${index}.ts`, { additions: 0, deletions: 0 })
		)
		for (const [additions, deletions] of [
			[added, removed],
			[removed, added],
		] as const) {
			expect(
				isMechanicalChange(
					[...rest, file('large.ts', { additions, deletions })],
					[]
				)
			).toBe(true)
			expect(
				isMechanicalChange(
					[
						...rest,
						file('large.ts', {
							additions: additions + (additions > deletions ? 1 : -1),
							deletions,
						}),
					],
					[]
				)
			).toBe(false)
		}
	})
	test('zero changed lines avoid division by zero', () =>
		expect(
			isMechanicalChange(
				edits(MECHANICAL_MIN_FILES).map(entry => ({
					...entry,
					additions: 0,
					deletions: 0,
				})),
				[]
			)
		).toBe(true))
})

describe('getChangeShape', () => {
	test('reports every failed condition in constant order', () => {
		const files = [
			file('config.ts', {
				additions: MECHANICAL_REWRITE_MIN_LINES,
				deletions: 0,
			}),
		]
		expect(getChangeShape(files, ['config.ts'])).toEqual({
			files: 1,
			smallShare: 0,
			netShare: 1,
			riskyRewrites: ['config.ts'],
			failed: MECHANICAL_CONDITIONS,
		})
	})
	test('empty input has finite zero shares and only count and small-share failures', () => {
		expect(getChangeShape([], [])).toEqual({
			files: 0,
			smallShare: 0,
			netShare: 0,
			riskyRewrites: [],
			failed: ['files', 'small_share'],
		})
	})
	test('measures only reviewable files and reports rewrites once in file order', () => {
		const files = [
			...edits(MECHANICAL_MIN_FILES),
			file('b.ts', {
				additions: MECHANICAL_REWRITE_MIN_LINES / 2,
				deletions: MECHANICAL_REWRITE_MIN_LINES / 2,
			}),
			file('a.ts', {
				additions: MECHANICAL_REWRITE_MIN_LINES / 2,
				deletions: MECHANICAL_REWRITE_MIN_LINES / 2,
			}),
			file('ignored.ts', {
				skipped: 'too_large',
				additions: 100_000,
				deletions: 0,
			}),
		]
		expect(
			getChangeShape(files, [
				'ignored.ts',
				'a.ts',
				'b.ts',
				'a.ts',
				'missing.ts',
			])
		).toEqual({
			files: MECHANICAL_MIN_FILES + 2,
			smallShare: MECHANICAL_MIN_FILES / (MECHANICAL_MIN_FILES + 2),
			netShare: 0,
			riskyRewrites: ['b.ts', 'a.ts'],
			failed: ['risky_rewrite'],
		})
	})
	test.each([MECHANICAL_MIN_FILES - 1, MECHANICAL_MIN_FILES])(
		'measures the file-count boundary at %i',
		count => {
			const shape = getChangeShape(edits(count, count), [])
			expect(shape).toEqual({
				files: count,
				smallShare: 1,
				netShare: 0,
				riskyRewrites: [],
				failed: count < MECHANICAL_MIN_FILES ? ['files'] : [],
			})
			expect(isMechanicalChange(edits(count, count), [])).toBe(
				shape.failed.length === 0
			)
		}
	)
	test.each([0, 1])(
		'measures the small-share boundary with %i fewer small files',
		fewer => {
			const small = MECHANICAL_MIN_FILES * MECHANICAL_MIN_SMALL_SHARE - fewer
			expect(getChangeShape(edits(small), [])).toEqual({
				files: MECHANICAL_MIN_FILES,
				smallShare: small / MECHANICAL_MIN_FILES,
				netShare: 0,
				riskyRewrites: [],
				failed: fewer ? ['small_share'] : [],
			})
		}
	)
	test.each([0, 1])(
		'measures the net-share boundary with %i excess lines',
		excess => {
			const total = 400
			const additions = (total * (1 + MECHANICAL_MAX_NET_SHARE)) / 2 + excess
			const deletions = (total * (1 - MECHANICAL_MAX_NET_SHARE)) / 2 - excess
			const files = [
				...edits(MECHANICAL_MIN_FILES - 1, MECHANICAL_MIN_FILES - 1).map(
					entry => ({ ...entry, additions: 0, deletions: 0 })
				),
				file('large.ts', { additions, deletions }),
			]
			for (const reversed of [false, true]) {
				const shape = getChangeShape(
					files.map(entry =>
						reversed
							? {
									...entry,
									additions: entry.deletions,
									deletions: entry.additions,
								}
							: entry
					),
					[]
				)
				expect(shape).toEqual({
					files: MECHANICAL_MIN_FILES,
					smallShare: (MECHANICAL_MIN_FILES - 1) / MECHANICAL_MIN_FILES,
					netShare: (total * MECHANICAL_MAX_NET_SHARE + 2 * excess) / total,
					riskyRewrites: [],
					failed: excess ? ['net_share'] : [],
				})
			}
		}
	)
})
