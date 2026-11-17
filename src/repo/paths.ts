import { posix } from 'node:path'

/**
 * Normalizes a repository-relative path. Returns null for absolute paths, paths that leave the
 * repository root, and paths with NUL bytes. `""` and `"."` both mean the root.
 */
export function normalizeRepoPath(input: string): string | null {
  if (input.includes('\0') || input.includes('\\')) return null
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) return null
  const normalized = posix.normalize(input === '' ? '.' : input).replace(/\/+$/, '')
  if (normalized === '..' || normalized.startsWith('../')) return null
  return normalized === '' ? '.' : normalized
}
