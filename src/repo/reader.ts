import { readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { decode, type Git } from '../git/git.ts'
import { normalizeRepoPath } from './paths.ts'

/** Read access to `.mng/` files and imports, either at a git ref or in the working tree. */
export interface RepoReader {
  /** Where the files come from, for messages: a ref name or "working tree". */
  readonly source: string
  /** File text, or null when the file does not exist. */
  readFile(path: string): Promise<string | null>
  /** File names directly inside a directory, or null when it does not exist. */
  listFiles(path: string): Promise<string[] | null>
}

export function gitRefReader(git: Git, ref: string, commit: string): RepoReader {
  return {
    source: ref,
    async readFile(path) {
      const clean = requirePath(path)
      const result = await git.exec(['show', '--no-textconv', `${commit}:${clean}`])
      return result.exitCode === 0 ? decode(result.stdout) : null
    },
    async listFiles(path) {
      const clean = requirePath(path)
      const result = await git.exec(['ls-tree', '-z', commit, '--', `${clean}/`])
      if (result.exitCode !== 0) return null
      const entries = decode(result.stdout).split('\0').filter(Boolean)
      if (entries.length === 0) return null
      return entries
        .map(entry => entry.split('\t'))
        .filter(([meta]) => meta?.split(' ')[1] === 'blob')
        .map(([, name]) => name?.slice(clean.length + 1) ?? '')
        .filter(Boolean)
        .toSorted()
    },
  }
}

export function worktreeReader(root: string): RepoReader {
  const inside = async (path: string): Promise<string | null> => {
    const full = join(root, requirePath(path))
    try {
      const [real, realRoot] = await Promise.all([realpath(full), realpath(root)])
      return real === realRoot || real.startsWith(realRoot + sep) ? real : null
    } catch {
      return null
    }
  }
  return {
    source: 'working tree',
    async readFile(path) {
      const full = await inside(path)
      if (!full) return null
      try {
        return await Bun.file(full).text()
      } catch {
        return null
      }
    },
    async listFiles(path) {
      const full = await inside(path)
      if (!full) return null
      try {
        const entries = await readdir(full, { withFileTypes: true })
        return entries
          .filter(entry => entry.isFile())
          .map(entry => entry.name)
          .toSorted()
      } catch {
        return null
      }
    },
  }
}

function requirePath(path: string): string {
  const clean = normalizeRepoPath(path)
  if (clean === null || clean === '.') throw new Error(`path outside the repository: ${path}`)
  return clean
}
