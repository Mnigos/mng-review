import type { LineFold } from '@mng-review/engine'

/** `@@ -a[,b] +c[,d] @@`; an omitted count is 1. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u
/** The head path in a file header; quoted paths (special characters) are not matched. */
const NEW_PATH = /^\+\+\+ b\/(.+)$/u
/** Longest diff line the fold keeps whole; hunk headers and paths are far shorter. */
export const DIFF_LINE_CHARS = 4096

/** One hunk's position on both sides. */
export interface HunkHeader {
	readonly oldStart: number
	readonly oldCount: number
	readonly newStart: number
	readonly newCount: number
}

/** The hunk header of a diff line, or `undefined` for any other line. */
export function parseHunkHeader(line: string): HunkHeader | undefined {
	const match = HUNK_HEADER.exec(line)
	if (!match) return undefined
	return {
		oldStart: Number(match[1]),
		oldCount: match[2] === undefined ? 1 : Number(match[2]),
		newStart: Number(match[3]),
		newCount: match[4] === undefined ? 1 : Number(match[4]),
	}
}

/**
 * Where the fold is: the current head path, the next head line, and how many base and head lines
 * of the current hunk are still to come. A line inside a hunk is never read as a header, so an
 * added line that starts with `++ ` stays content.
 */
export interface DiffLinesState {
	readonly path: string | undefined
	readonly next: number
	readonly oldLeft: number
	readonly newLeft: number
	readonly lines: Map<string, Set<number>>
}

/** Adds the next head line of the current file. */
function addLine(state: DiffLinesState): void {
	if (state.path === undefined) return
	const lines = state.lines.get(state.path) ?? new Set<number>()
	lines.add(state.next)
	state.lines.set(state.path, lines)
}

/** One line inside a hunk: context and added lines are head lines, removed ones only count down. */
function stepHunkLine(state: DiffLinesState, line: string): DiffLinesState {
	if (line.startsWith('\\')) return state
	if (line.startsWith('-')) return { ...state, oldLeft: state.oldLeft - 1 }
	addLine(state)
	const context = !line.startsWith('+')
	return {
		...state,
		next: state.next + 1,
		newLeft: state.newLeft - 1,
		oldLeft: context ? state.oldLeft - 1 : state.oldLeft,
	}
}

/** One step over a line of `git diff`: file headers between hunks, hunk headers, hunk lines. */
function stepDiffLine(state: DiffLinesState, line: string): DiffLinesState {
	if (state.oldLeft > 0 || state.newLeft > 0) return stepHunkLine(state, line)
	if (line.startsWith('diff --git ')) return { ...state, path: undefined }
	if (line.startsWith('+++ '))
		return { ...state, path: NEW_PATH.exec(line)?.[1] }
	const hunk = parseHunkHeader(line)
	if (!hunk) return state
	return {
		...state,
		next: hunk.newStart,
		oldLeft: hunk.oldCount,
		newLeft: hunk.newCount,
	}
}

/**
 * A fold of `git diff` output (with `a/` and `b/` prefixes) into the head lines GitHub accepts an
 * inline comment on: context and added lines of every hunk. Each call starts from an empty map.
 */
export function createCommentableLinesFold(): LineFold<DiffLinesState> {
	return {
		initial: {
			path: undefined,
			next: 0,
			oldLeft: 0,
			newLeft: 0,
			lines: new Map(),
		},
		maxLineChars: DIFF_LINE_CHARS,
		step: stepDiffLine,
	}
}
