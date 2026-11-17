import type { Config } from '../config/schema.ts'
import { decode, type Git } from '../git/git.ts'
import { matchesAny } from '../routing/glob.ts'

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed'

export type FileSkipReason = 'skip.paths' | 'binary' | 'too_large'

export interface ChangedFile {
  path: string
  /** Path at the base for renames and copies. */
  oldPath?: string
  status: FileStatus
  additions: number
  deletions: number
  binary: boolean
  /** Size at head in bytes; 0 for deleted files. */
  sizeBytes: number
  /** Set when the file is left out of the review. */
  skipped?: FileSkipReason
}

export interface Change {
  base: { ref: string; commit: string }
  head: { ref: string; commit: string }
  mergeBase: string
  files: ChangedFile[]
}

const statusCodes: Record<string, FileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type_changed',
}

/** Changed files between the merge base of `base` and `head`, and `head`. */
export async function readChange(git: Git, baseRef: string, headRef: string): Promise<Change> {
  const [base, head] = await Promise.all([git.resolveCommit(baseRef), git.resolveCommit(headRef)])
  const mergeBase = await git.mergeBase(base, head)
  const range = ['-M', '--no-ext-diff', '--no-textconv', mergeBase, head]
  const [nameStatus, numstat] = await Promise.all([
    git.text(['diff', '--name-status', '-z', ...range]),
    git.text(['diff', '--numstat', '-z', ...range]),
  ])
  const files = parseNameStatus(nameStatus)
  const counts = parseNumstat(numstat)
  const sizes = await blobSizes(
    git,
    head,
    files.filter(f => f.status !== 'deleted').map(f => f.path),
  )
  for (const file of files) {
    const count = counts.get(file.path)
    if (count) {
      file.additions = count.additions
      file.deletions = count.deletions
      file.binary = count.binary
    }
    file.sizeBytes = sizes.get(file.path) ?? 0
  }
  return {
    base: { ref: baseRef, commit: base },
    head: { ref: headRef, commit: head },
    mergeBase,
    files,
  }
}

export function parseNameStatus(output: string): ChangedFile[] {
  const parts = output.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length;) {
    const code = parts[i++]
    if (!code) continue
    const status = statusCodes[code[0] ?? ''] ?? 'modified'
    const twoPaths = status === 'renamed' || status === 'copied'
    const first = parts[i++] ?? ''
    const second = twoPaths ? (parts[i++] ?? '') : undefined
    files.push({
      path: second ?? first,
      ...(second === undefined ? {} : { oldPath: first }),
      status,
      additions: 0,
      deletions: 0,
      binary: false,
      sizeBytes: 0,
    })
  }
  return files
}

interface LineCount {
  additions: number
  deletions: number
  binary: boolean
}

/** Parses `git diff --numstat -z`; renames carry an empty path field then old and new paths. */
export function parseNumstat(output: string): Map<string, LineCount> {
  const parts = output.split('\0')
  const counts = new Map<string, LineCount>()
  for (let i = 0; i < parts.length;) {
    const entry = parts[i++]
    if (!entry) continue
    const [added = '', deleted = '', path = ''] = entry.split('\t')
    let target = path
    if (path === '') {
      i++ // old path
      target = parts[i++] ?? ''
    }
    const binary = added === '-' && deleted === '-'
    counts.set(target, {
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(deleted),
      binary,
    })
  }
  return counts
}

async function blobSizes(git: Git, commit: string, paths: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  if (paths.length === 0) return sizes
  const input = paths.map(path => `${commit}:${path}\n`).join('')
  const result = await git.exec(['cat-file', '--batch-check=%(objecttype) %(objectsize)'], input)
  const lines = decode(result.stdout).split('\n')
  paths.forEach((path, index) => {
    const [type, size] = (lines[index] ?? '').split(' ')
    if (type === 'blob' && size) sizes.set(path, Number(size))
  })
  return sizes
}

/** Marks files the review leaves out: `skip.paths`, binary files and files over the size limit. */
export function applyFileSkips(files: ChangedFile[], config: Config): ChangedFile[] {
  const maxBytes = config.limits.max_file_kb * 1024
  return files.map(file => {
    const { skipped: _, ...rest } = file
    if (matchesAny(file.path, config.skip.paths)) return { ...rest, skipped: 'skip.paths' }
    if (file.binary) return { ...rest, skipped: 'binary' }
    if (file.sizeBytes > maxBytes) return { ...rest, skipped: 'too_large' }
    return rest
  })
}

export function reviewableFiles(files: ChangedFile[]): ChangedFile[] {
  return files.filter(file => !file.skipped)
}

/** Unified diff text of the given files between the merge base and head. */
export async function readDiff(git: Git, change: Change, paths: string[]): Promise<string> {
  if (paths.length === 0) return ''
  return git.text([
    'diff',
    '-M',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    change.mergeBase,
    change.head.commit,
    '--',
    ...paths.map(path => `:(literal)${path}`),
  ])
}
