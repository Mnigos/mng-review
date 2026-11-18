import {
	file,
	mechanicalFiles,
	featureFiles,
} from '../../shared/mocks/domain-test.helper'
import {
	MECHANICAL_MIN_FILES,
	MECHANICAL_MIN_SMALL_SHARE,
	MECHANICAL_MIN_RISKY_SMALL_SHARE,
	MECHANICAL_MAX_NET_SHARE,
	SMALL_EDIT_MAX_LINES,
} from '../routing.constants'
import { isMechanicalChange } from './change-shape.helper'

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

	test('requires the small-edit share independently within risk paths', () => {
		const files = edits(40)
		const count = 10
		const small = count * MECHANICAL_MIN_RISKY_SMALL_SHARE
		const hits = [
			...files.slice(0, small),
			...files.slice(40, 40 + count - small),
		].map(entry => entry.path)
		expect(isMechanicalChange(files, hits)).toBe(true)
		expect(
			isMechanicalChange(files, [...hits.slice(1), 'src/file-42.ts'])
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
