import { parseFloorDiff } from './floor-diff.parser'

/** A raw header in git's combined raw/numstat NUL-delimited output. */
function raw(
	path: string,
	status = 'M',
	oldMode = '100644',
	newMode = '100644'
): string {
	return `:${oldMode} ${newMode} abc1234 def5678 ${status}\u0000${path}\u0000`
}

describe('parseFloorDiff', () => {
	test.each([
		['modified', 'M', '100644', '100644', '4\t2', { added: 4, deleted: 2 }],
		['added', 'A', '000000', '100644', '4\t0', { added: 4, deleted: 0 }],
		['deleted', 'D', '100644', '000000', '0\t2', { added: 0, deleted: 2 }],
		['mode change', 'M', '100644', '100755', '0\t0', { added: 0, deleted: 0 }],
		['symlink', 'T', '100644', '120000', '1\t1', { added: 1, deleted: 1 }],
		['submodule', 'M', '160000', '160000', '1\t1', { added: 1, deleted: 1 }],
		['binary', 'M', '100644', '100644', '-\t-', 'binary'],
		['unknown addition', 'M', '100644', '100644', 'x\t1', 'unknown'],
		['mixed binary', 'M', '100644', '100644', '-\t3', 'unknown'],
		[
			'unsafe addition',
			'M',
			'100644',
			'100644',
			'9007199254740992\t1',
			'unknown',
		],
		[
			'unsafe deletion',
			'M',
			'100644',
			'100644',
			'1\t9007199254740992',
			'unknown',
		],
		['overflow', 'M', '100644', '100644', `${'9'.repeat(400)}\t1`, 'unknown'],
	] as const)('reads %s', (_name, status, oldMode, newMode, counts, count) => {
		expect(
			parseFloorDiff(
				`${raw('src/file.ts', status, oldMode, newMode)}${counts}\tsrc/file.ts\u0000`
			)
		).toEqual({
			intact: true,
			files: [{ path: 'src/file.ts', status, oldMode, newMode, count }],
		})
	})
	test('preserves tabs and newlines in paths', () => {
		const path = 'src/a\tb\nfile.ts'
		expect(parseFloorDiff(`${raw(path)}3\t2\t${path}\u0000`)).toEqual({
			intact: true,
			files: [
				{
					path,
					status: 'M',
					oldMode: '100644',
					newMode: '100644',
					count: { added: 3, deleted: 2 },
				},
			],
		})
	})
	test('reads all raw records before all numstat records, matching counts by path', () => {
		expect(
			parseFloorDiff(
				`${raw('first.ts')}${raw('second.ts')}2\t3\tsecond.ts\u0000` +
					'1\t0\tfirst.ts\u0000'
			)
		).toEqual({
			intact: true,
			files: [
				{
					path: 'first.ts',
					status: 'M',
					oldMode: '100644',
					newMode: '100644',
					count: { added: 1, deleted: 0 },
				},
				{
					path: 'second.ts',
					status: 'M',
					oldMode: '100644',
					newMode: '100644',
					count: { added: 2, deleted: 3 },
				},
			],
		})
	})
	test('retains both sides of a no-renames delete plus add', () => {
		expect(
			parseFloorDiff(
				`${raw('.github/old.yml', 'D', '100644', '000000')}${raw('src/new.yml', 'A', '000000', '100644')}0\t5\t.github/old.yml\u0000` +
					'5\t0\tsrc/new.yml\u0000'
			)
		).toEqual({
			intact: true,
			files: [
				{
					path: '.github/old.yml',
					status: 'D',
					oldMode: '100644',
					newMode: '000000',
					count: { added: 0, deleted: 5 },
				},
				{
					path: 'src/new.yml',
					status: 'A',
					oldMode: '000000',
					newMode: '100644',
					count: { added: 5, deleted: 0 },
				},
			],
		})
	})
	test.each(['R100', 'C075'])(
		'counts unexpected %s records at both paths',
		status => {
			expect(
				parseFloorDiff(
					`${raw('old\tname.ts', status)}new.ts\u0000` +
						'2\t1\t\u0000old\tname.ts\u0000new.ts\u0000'
				)
			).toEqual({
				intact: true,
				files: ['old\tname.ts', 'new.ts'].map(path => ({
					path,
					status: status.charAt(0),
					oldMode: '100644',
					newMode: '100644',
					count: { added: 2, deleted: 1 },
				})),
			})
		}
	)
	test('retains a raw record without counts as unknown', () => {
		expect(parseFloorDiff(raw('file.ts'))).toEqual({
			intact: false,
			files: [
				{
					path: 'file.ts',
					status: 'M',
					oldMode: '100644',
					newMode: '100644',
					count: 'unknown',
				},
			],
		})
	})
	test('retains a count without raw modes and marks the diff incomplete', () => {
		expect(parseFloorDiff('1\t2\tfile.ts\u0000')).toEqual({
			intact: false,
			files: [
				{
					path: 'file.ts',
					status: '',
					oldMode: '',
					newMode: '',
					count: { added: 1, deleted: 2 },
				},
			],
		})
	})
	test.each([
		':100644 100644 abc1234 def5678 M\u0000',
		':100644 100644 abc1234 def5678 R100\u0000old.ts\u0000',
		`${raw('file.ts')}1\t2\u0000`,
		`${raw('file.ts')}1\t2\t\u0000old.ts\u0000`,
		`${raw('first.ts')}1\t0\tfirst.ts\u0000${raw('second.ts')}`,
		`${raw('file.ts')}1\t2\tother.ts\u0000`,
	])('fails closed on an incomplete or out-of-order record %j', output => {
		expect(parseFloorDiff(output).intact).toBe(false)
	})
	test('rejects a truncated final NUL-delimited count', () => {
		expect(parseFloorDiff(`${raw('file.ts')}1\t2\tfile.ts`).intact).toBe(false)
	})
	test.each([
		['an unknown status', 'Q', '100644', '100644'],
		['an unmerged status', 'U', '100644', '100644'],
		['a non-canonical old mode', 'M', '100600', '100644'],
		['a non-canonical new mode', 'M', '100644', '100664'],
	] as const)('fails closed on %s', (_name, status, oldMode, newMode) => {
		expect(
			parseFloorDiff(
				`${raw('src/file.ts', status, oldMode, newMode)}1\t1\tsrc/file.ts\u0000`
			).intact
		).toBe(false)
	})
	test('reads empty output as an intact empty change', () => {
		expect(parseFloorDiff('')).toEqual({ intact: true, files: [] })
	})
})

test('parses captured git diff --no-renames --raw --numstat -z output', () => {
	const output =
		':000000 100644 0000000 d5f7fc3 A\u0000added.txt\u0000:100644 100644 82a60be 843f4dc M\u0000binary.bin\u0000:100644 000000 c8b1b42 0000000 D\u0000deleted.txt\u0000:120000 120000 a707117 33b030c M\u0000link\u0000:100644 100755 e8117c6 e8117c6 M\u0000mode.sh\u0000:100644 100644 90be1f3 294186e M\u0000modified.txt\u0000:000000 100644 0000000 b297ab5 A\u0000new-name.txt\u0000:100644 000000 b297ab5 0000000 D\u0000old-name.txt\u0000:100644 100644 90be1f3 294186e M\u0000tab\tname.txt\u00001\t0\tadded.txt\u0000-\t-\tbinary.bin\u00000\t1\tdeleted.txt\u00001\t1\tlink\u00000\t0\tmode.sh\u00001\t1\tmodified.txt\u00001\t0\tnew-name.txt\u00000\t1\told-name.txt\u00001\t1\ttab\tname.txt\u0000'
	const diff = parseFloorDiff(output)
	expect(diff.intact).toBe(true)
	expect(
		diff.files.map(({ path, status, oldMode, newMode, count }) => [
			path,
			status,
			oldMode,
			newMode,
			count,
		])
	).toEqual([
		['added.txt', 'A', '000000', '100644', { added: 1, deleted: 0 }],
		['binary.bin', 'M', '100644', '100644', 'binary'],
		['deleted.txt', 'D', '100644', '000000', { added: 0, deleted: 1 }],
		['link', 'M', '120000', '120000', { added: 1, deleted: 1 }],
		['mode.sh', 'M', '100644', '100755', { added: 0, deleted: 0 }],
		['modified.txt', 'M', '100644', '100644', { added: 1, deleted: 1 }],
		['new-name.txt', 'A', '000000', '100644', { added: 1, deleted: 0 }],
		['old-name.txt', 'D', '100644', '000000', { added: 0, deleted: 1 }],
		['tab\tname.txt', 'M', '100644', '100644', { added: 1, deleted: 1 }],
	])
})
