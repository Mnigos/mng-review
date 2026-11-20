import { type LineRange, matchesGlob } from '@mng-review/domain'
import { MAX_TRUNCATION_MARKER_CHARS } from '../../../utils/fence.util'
import {
	MAX_GREP_LINES,
	MAX_TOOL_OUTPUT_CHARS,
} from '../domain/review.constants'

/** A file read line by line: the numbered lines kept so far, the lines seen and whether one held a NUL. */
export interface NumberedLines {
	readonly text: string
	readonly seen: number
	readonly binary: boolean
	/**
	 * The last kept line that ends inside the part a cut output keeps, so the agent sees it whole even
	 * when `truncateText` cuts the text; 0 for none. A line `splitCappedLines` cut is longer than that
	 * part and never counts.
	 */
	readonly whole: number
}

/** Kept text up to this length survives any cut to `MAX_TOOL_OUTPUT_CHARS`. */
const WHOLE_LINE_BOUND = MAX_TOOL_OUTPUT_CHARS - MAX_TRUNCATION_MARKER_CHARS

/** Matches read record by record: the lines kept so far, how many, and how many more were found. */
export interface GrepMatches {
	readonly text: string
	readonly shown: number
	readonly rest: number
}

/** Appends a line to kept text. */
function appendLine(text: string, line: string): string {
	return text === '' ? line : `${text}\n${line}`
}

/** Keeps a line, numbered, when it lies in the range and the kept text is still under the output cap. */
export function addNumberedLine(range: LineRange | undefined) {
	return (state: NumberedLines, line: string): NumberedLines => {
		const number = state.seen + 1
		const binary = state.binary || line.includes('\0')
		const shown =
			number >= (range?.start ?? 1) &&
			number <= (range?.end ?? Number.POSITIVE_INFINITY) &&
			state.text.length <= MAX_TOOL_OUTPUT_CHARS
		if (!shown) return { ...state, seen: number, binary }
		const text = appendLine(state.text, `${number}| ${line}`)
		return {
			seen: number,
			binary,
			text,
			whole: text.length <= WHOLE_LINE_BOUND ? number : state.whole,
		}
	}
}

/** Keeps a `git grep -z` record as `path:line:text` when it matches the glob and `MAX_GREP_LINES` is not reached. */
export function addGrepMatch(commit: string, glob: string | undefined) {
	const prefix = `${commit}:`
	return (state: GrepMatches, record: string): GrepMatches => {
		const [file = '', line = '', ...text] = record.split('\0')
		const path = file.startsWith(prefix) ? file.slice(prefix.length) : file
		if (record === '' || (glob !== undefined && !matchesGlob(path, glob)))
			return state
		if (state.shown >= MAX_GREP_LINES) return { ...state, rest: state.rest + 1 }
		return {
			...state,
			shown: state.shown + 1,
			text: appendLine(state.text, `${path}:${line}:${text.join('\0')}`),
		}
	}
}
