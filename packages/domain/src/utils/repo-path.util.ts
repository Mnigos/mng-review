/** Absolute POSIX paths, Windows drive paths, backslashes and NUL bytes. */
const UNSAFE_PATH = /^\/|^[A-Za-z]:|[\\\0]/u

/**
 * Normalises a repository-relative path. Returns `undefined` for an absolute or Windows path, a
 * backslash, a NUL byte or a path that leaves the repository; `''` and `.` both give `.`, the root.
 */
export function normalizeRepoPath(path: string): string | undefined {
	if (UNSAFE_PATH.test(path)) return undefined
	const segments: string[] = []
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.') continue
		if (segment !== '..') {
			segments.push(segment)
			continue
		}
		if (segments.length === 0) return undefined
		segments.pop()
	}
	return segments.length === 0 ? '.' : segments.join('/')
}
