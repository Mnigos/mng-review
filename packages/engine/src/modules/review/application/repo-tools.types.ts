import type { LineRange } from '@mng-review/domain'
import type { TOOL_REFS } from './repo.toolkit'

/** The tree a tool reads: the head, or the merge base for `base`. */
export type ToolRef = (typeof TOOL_REFS)[number]

/** The file lines a `read_file` output holds whole, taken from its arguments and the file, never its text. */
export interface ShownLines {
	readonly ref: ToolRef
	readonly path: string
	readonly lines: LineRange
	/** The output was cut, so lines of the asked range after `lines.end` were not shown whole. */
	readonly truncated: boolean
}

/** A tool's output and, for a `read_file` that showed lines, which ones. */
export interface ToolResult {
	readonly output: string
	readonly shown?: ShownLines
}
