const cache = new Map<string, Bun.Glob>()

function glob(pattern: string): Bun.Glob {
  let compiled = cache.get(pattern)
  if (!compiled) {
    compiled = new Bun.Glob(pattern)
    cache.set(pattern, compiled)
  }
  return compiled
}

/**
 * True when `path` matches any pattern. A pattern ending in `/**` also matches the directory
 * itself, and a pattern without a slash matches the file name in any directory (like `.gitignore`).
 */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => matches(path, pattern))
}

export function matches(path: string, pattern: string): boolean {
  if (glob(pattern).match(path)) return true
  if (pattern.endsWith('/**') && path === pattern.slice(0, -3)) return true
  if (!pattern.includes('/')) return glob(`**/${pattern}`).match(path)
  return false
}
