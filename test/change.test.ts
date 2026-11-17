import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyFileSkips,
  parseNameStatus,
  parseNumstat,
  readChange,
  reviewableFiles,
} from '../src/change/change.ts'
import { Git } from '../src/git/git.ts'
import { config, file } from './support/fakes.ts'
import { TempRepo } from './support/git.ts'

describe('NUL-delimited change parsers', () => {
  test('name status parses ordinary files, rename/copy pairs and type changes', () => {
    const parsed = parseNameStatus(
      'A\0new file.ts\0M\0src/auth.ts\0D\0old.ts\0R100\0old name.ts\0new name.ts\0C075\0source.ts\0copy.ts\0T\0link\0',
    )
    expect(parsed.map(({ path, oldPath, status }) => ({ path, oldPath, status }))).toEqual([
      { path: 'new file.ts', oldPath: undefined, status: 'added' },
      { path: 'src/auth.ts', oldPath: undefined, status: 'modified' },
      { path: 'old.ts', oldPath: undefined, status: 'deleted' },
      { path: 'new name.ts', oldPath: 'old name.ts', status: 'renamed' },
      { path: 'copy.ts', oldPath: 'source.ts', status: 'copied' },
      { path: 'link', oldPath: undefined, status: 'type_changed' },
    ])
    expect(
      parsed.every(f => f.additions === 0 && f.deletions === 0 && !f.binary && f.sizeBytes === 0),
    ).toBe(true)
    expect(parseNameStatus('')).toEqual([])
  })
  test('numstat parses text counts, renames, binary files and embedded newlines', () => {
    expect(
      Object.fromEntries(
        parseNumstat(
          '2\t1\tsrc/auth.ts\0' +
            '0\t0\t\0old.ts\0new.ts\0' +
            '-\t-\timage.bin\0' +
            '1\t3\tline\nbreak.ts\0',
        ),
      ),
    ).toEqual({
      'src/auth.ts': { additions: 2, deletions: 1, binary: false },
      'new.ts': { additions: 0, deletions: 0, binary: false },
      'image.bin': { additions: 0, deletions: 0, binary: true },
      'line\nbreak.ts': { additions: 1, deletions: 3, binary: false },
    })
    expect(parseNumstat('').size).toBe(0)
  })
  test('binary rename uses the new path', () => {
    expect(Object.fromEntries(parseNumstat('-\t-\t\0old.bin\0new.bin\0'))).toEqual({
      'new.bin': { additions: 0, deletions: 0, binary: true },
    })
  })
})

describe('readChange in a real git repo', () => {
  let repo: TempRepo | undefined
  afterEach(async () => {
    await repo?.cleanup()
    repo = undefined
  })
  test('records add/modify/delete/rename/binary counts and sizes from the merge base after base advances', async () => {
    repo = await TempRepo.create()
    await repo.write('src/modify.ts', 'old\nkeep\n')
    await repo.write('src/delete.ts', 'gone\n')
    await repo.write('src/rename.ts', 'unique renamed content\n')
    const mergeBase = await repo.commit('base')
    await repo.git('checkout', '-b', 'feature')
    await repo.write('src/add.ts', 'added\nsecond\n')
    await repo.write('src/modify.ts', 'new\nkeep\nextra\n')
    await repo.remove('src/delete.ts')
    await repo.git('mv', 'src/rename.ts', 'src/renamed.ts')
    const binary = new Uint8Array([0, 1, 2, 3, 0, 255])
    await repo.write('assets/image.bin', binary)
    const head = await repo.commit('change')
    await repo.git('checkout', 'main')
    await repo.write('base-only.ts', 'not part of the change\n')
    const advancedBase = await repo.commit('advance base')
    await repo.git('checkout', 'feature')
    // Head bytes, not uncommitted working-tree bytes, decide the size.
    await repo.write('src/add.ts', 'uncommitted and much longer')
    const change = await readChange(await Git.open(repo.root), 'main', 'HEAD')
    expect(change.base).toEqual({ ref: 'main', commit: advancedBase })
    expect(change.head).toEqual({ ref: 'HEAD', commit: head })
    expect(change.mergeBase).toBe(mergeBase)
    expect(change.files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      file('assets/image.bin', {
        status: 'added',
        additions: 0,
        deletions: 0,
        binary: true,
        sizeBytes: binary.byteLength,
      }),
      file('src/add.ts', { status: 'added', additions: 2, deletions: 0, sizeBytes: 13 }),
      file('src/delete.ts', { status: 'deleted', additions: 0, deletions: 1, sizeBytes: 0 }),
      file('src/modify.ts', { additions: 2, deletions: 1, sizeBytes: 15 }),
      file('src/renamed.ts', {
        status: 'renamed',
        oldPath: 'src/rename.ts',
        additions: 0,
        deletions: 0,
        sizeBytes: 23,
      }),
    ])
  })
})

describe('file skips', () => {
  test('applies path, binary, and byte-size skips in order, includes the exact size limit, and does not mutate inputs', () => {
    const cfg = config('skip: {paths: [generated/**]}\nlimits: {max_file_kb: 1}')
    const files = [
      file('generated/all.bin', { binary: true, sizeBytes: 2048 }),
      file('image.bin', { binary: true, sizeBytes: 2048 }),
      file('large.ts', { sizeBytes: 1025 }),
      file('boundary.ts', { sizeBytes: 1024 }),
      file('small.ts', { sizeBytes: 1023, skipped: 'too_large' }),
    ]
    const before = structuredClone(files)
    const skipped = applyFileSkips(files, cfg)
    expect(skipped.map(f => f.skipped)).toEqual([
      'skip.paths',
      'binary',
      'too_large',
      undefined,
      undefined,
    ])
    expect(reviewableFiles(skipped).map(f => f.path)).toEqual(['boundary.ts', 'small.ts'])
    expect(files).toEqual(before)
  })
})
