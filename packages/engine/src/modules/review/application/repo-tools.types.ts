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

/**
 * The characters of one file's section of a `diff` output the part holds: `from` to `to` of the
 * section's `size`, so the parts of a long diff add up to the whole file.
 */
export interface DiffPart {
	readonly path: string
	readonly size: number
	readonly from: number
	readonly to: number
}

/** A tool's output and, for a `read_file` that showed lines or a `diff`, what it held. */
export interface ToolResult {
	readonly output: string
	readonly shown?: ShownLines
	readonly diff?: readonly DiffPart[]
}
