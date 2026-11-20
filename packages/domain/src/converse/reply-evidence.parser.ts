import type { LineRange } from '../review/line-range.parser'
import { normalizeRepoPath } from '../utils/repo-path.util'

/** A `path:line` or `path:start-end` evidence entry with its path normalised. */
export interface EvidenceRef {
	readonly path: string
	readonly lines: LineRange
}

/** `path:line` or `path:start-end`, then a space or the end; the path may hold spaces, not colons. */
const EVIDENCE_REF = /^([^\s:](?:[^:]*[^\s:])?):(\d+)(?:-(\d+))?(?:\s|$)/u
/** A hunk header of `git diff -U0`: `@@ -a[,b] +c[,d] @@`. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u

/**
 * Reads an evidence entry. An entry that does not start with `path:line`, names line 0, ends before
 * it starts, or whose path leaves the repository or names its root, gives `undefined`.
 */
export function parseEvidenceRef(entry: string): EvidenceRef | undefined {
	const match = EVIDENCE_REF.exec(entry.trim())
	if (!match) return undefined
	const path = normalizeRepoPath(match[1] ?? '')
	const start = Number(match[2])
	const end = match[3] === undefined ? start : Number(match[3])
	if (path === undefined || path === '.' || start < 1 || end < start)
		return undefined
	return { path, lines: { start, end } }
}

/** The head lines a `git diff -U0` output adds, one range per hunk that adds any. */
export function parseAddedRanges(diff: string): LineRange[] {
	return diff.split('\n').flatMap(line => {
		const match = HUNK_HEADER.exec(line)
		if (!match) return []
		const start = Number(match[1])
		const count = match[2] === undefined ? 1 : Number(match[2])
		return count === 0 ? [] : [{ start, end: start + count - 1 }]
	})
}
