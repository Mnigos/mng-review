import { config, file } from '../shared/mocks/domain-test.helper'
import { applyFileSkips, getReviewableFiles } from './file-skip.helper'

describe('applyFileSkips', () => {
	test('marks skip.paths, binary and files larger than the KB boundary in input order', () => {
		const cfg = config({
			skip: { paths: ['generated/**'] },
			limits: { max_file_kb: 1 },
		})
		const files = [
			file('ordinary.ts'),
			file('generated/code.ts'),
			file('image.bin', { binary: true }),
			file('large.ts', { sizeBytes: 1025 }),
			file('boundary.ts', { sizeBytes: 1024 }),
			file('below.ts', { sizeBytes: 1023 }),
			file('deleted.ts', { status: 'deleted', sizeBytes: 0 }),
		]
		const before = structuredClone({ files, cfg })
		expect(applyFileSkips(files, cfg)).toEqual([
			files[0],
			{ ...files[1], skipped: 'skip.paths' },
			{ ...files[2], skipped: 'binary' },
			{ ...files[3], skipped: 'too_large' },
			files[4],
			files[5],
			files[6],
		])
		expect({ files, cfg }).toEqual(before)
	})
	test('prefers skip.paths to binary and size, and binary to size', () => {
		const cfg = config({
			skip: { paths: ['ignored/**'] },
			limits: { max_file_kb: 1 },
		})
		expect(
			applyFileSkips(
				[
					file('ignored/blob.bin', { binary: true, sizeBytes: 2048 }),
					file('blob.bin', { binary: true, sizeBytes: 2048 }),
				],
				cfg
			).map(entry => entry.skipped)
		).toEqual(['skip.paths', 'binary'])
	})
	test('replaces an earlier mark and removes it when the file is reviewable', () => {
		const files = [
			file('ordinary.ts', { skipped: 'binary' }),
			file('image.bin', { binary: true, skipped: 'too_large' }),
		]
		const before = structuredClone(files)
		const marked = applyFileSkips(files, config())
		expect(marked).toEqual([
			file('ordinary.ts'),
			file('image.bin', { binary: true, skipped: 'binary' }),
		])
		expect(marked[0]).not.toHaveProperty('skipped')
		expect(files).toEqual(before)
	})
	test('empty input remains empty', () => {
		expect(applyFileSkips([], config())).toEqual([])
	})
})

describe('getReviewableFiles', () => {
	test('excludes each skip reason and preserves the relative order of reviewable files', () => {
		const first = file('first.ts')
		const second = file('second.ts')
		const files = [
			file('ignored.ts', { skipped: 'skip.paths' }),
			first,
			file('image.bin', { skipped: 'binary' }),
			second,
			file('large.ts', { skipped: 'too_large' }),
		]
		expect(getReviewableFiles(files)).toEqual([first, second])
		expect(files).toHaveLength(5)
		expect(getReviewableFiles([])).toEqual([])
	})
})
