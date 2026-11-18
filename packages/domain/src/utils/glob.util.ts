import { Glob } from 'effect'

/** Compiled patterns by source text; patterns come from `.mng/` files, so the set stays small. */
const COMPILED_GLOBS = new Map<string, Glob.Glob>()

/** Compiles a pattern once. Wildcards match dot files too, so `src/**` covers `src/.env`. */
function getGlob(pattern: string): Glob.Glob {
	const cached = COMPILED_GLOBS.get(pattern)
	if (cached) return cached
	const glob = Glob.make(pattern, { dot: true })
	COMPILED_GLOBS.set(pattern, glob)
	return glob
}

/**
 * True when the repository path matches the pattern. `dir/**` also matches `dir` itself, a pattern
 * without `/` matches the file name in any directory, as in `.gitignore`, and a leading `!` negates
 * the rest of the pattern, as `Bun.Glob` did.
 */
export function matchesGlob(path: string, pattern: string): boolean {
	if (pattern.startsWith('!')) return !matchesGlob(path, pattern.slice(1))
	if (Glob.match(getGlob(pattern), path)) return true
	return !pattern.includes('/') && Glob.match(getGlob(`**/${pattern}`), path)
}

/** True when the repository path matches any of the patterns. */
export function matchesAnyGlob(
	path: string,
	patterns: readonly string[]
): boolean {
	return patterns.some(pattern => matchesGlob(path, pattern))
}
