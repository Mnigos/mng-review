import { parseFileDiffs } from '@mng-review/domain'
import { getReadPaths } from '../domain/loop-message.helper'
import type { LoopCoverage, ToolOutput } from './agent-loop.types'
import type { DiffPart } from './repo-tools.types'
import { DiffTool } from './repo.toolkit'

/**
 * What an agent received: the paths any successful tool call touched (`getReadPaths`), which decide
 * a continuation turn, and for the files it read whole the characters of each file's diff section,
 * by path and section size, and the head lines `read_file` showed whole, by path. Both come from
 * the tools' arguments and git's output, never from the model.
 */
export interface ReadCoverage {
	readonly touched: ReadonlySet<string>
	readonly parts: ReadonlyMap<string, readonly DiffPart[]>
	readonly lines: ReadonlyMap<string, ReadonlySet<number>>
}

const FILE_HEADER = /^diff --git /gmu
const HUNK_HEAD = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u

/**
 * The sections of the files in `text`, a whole diff, that the part from `start` to `end` holds,
 * each with the characters of its own section it holds.
 */
export function getDiffParts(
	text: string,
	start: number,
	end: number
): readonly DiffPart[] {
	const starts = [...text.matchAll(FILE_HEADER)].map(match => match.index)
	return starts.flatMap((from, index) => {
		const to = starts[index + 1] ?? text.length
		const shownFrom = Math.max(from, start)
		const shownTo = Math.min(to, end)
		const path = parseFileDiffs(text.slice(from, to))[0]?.path
		if (shownTo <= shownFrom || path === undefined) return []
		return [
			{ path, size: to - from, from: shownFrom - from, to: shownTo - from },
		]
	})
}

/** The head lines a hunk adds, in order from the line its head range starts at. */
function toAddedLines(lines: readonly string[], first: number): number[] {
	// Added and context lines are the head's lines, in order from `first`.
	return lines
		.filter(line => line.startsWith('+') || line.startsWith(' '))
		.flatMap((line, index) => (line.startsWith('+') ? [first + index] : []))
}

/**
 * The head lines a file adds, which a `read_file` must show for the file to count as read; none
 * when a hunk deletes a line. A read of the head never shows what a deletion removed, so such a
 * file counts as read only when its diff came in full.
 */
function toChangedLines(hunks: readonly string[]): number[] {
	const split = hunks.map(hunk => hunk.split('\n'))
	if (split.some(([, ...lines]) => lines.some(line => line.startsWith('-'))))
		return []
	return split.flatMap(([head = '', ...lines]) =>
		toAddedLines(lines, Number(HUNK_HEAD.exec(head)?.[1] ?? 0))
	)
}

/** The head lines each file of `diff` adds (`toChangedLines`); none for a file that deletes a line. */
export function getChangedLines(
	diff: string
): ReadonlyMap<string, readonly number[]> {
	return new Map(
		parseFileDiffs(diff).map(file => [
			file.path,
			toChangedLines(file.hunks.map(hunk => hunk.text)),
		])
	)
}

/** `reads` with what one tool output the agent received showed: its paths, diff parts and head lines. */
export function addToolReads(
	reads: ReadCoverage,
	result: ToolOutput
): ReadCoverage {
	const { call } = result
	const touched = new Set([
		...reads.touched,
		...getReadPaths(call, result.output, call.name === DiffTool.name),
	])
	const parts = new Map(reads.parts)
	for (const part of result.diff ?? []) {
		const key = `${part.path}\0${part.size}`
		parts.set(key, [...(parts.get(key) ?? []), part])
	}
	const { shown } = result
	if (shown?.ref !== 'head') return { touched, parts, lines: reads.lines }
	const { start, end } = shown.lines
	const lines = new Map(reads.lines)
	lines.set(
		shown.path,
		new Set([
			...(lines.get(shown.path) ?? []),
			...Array.from({ length: end - start + 1 }, (_, index) => start + index),
		])
	)
	return { touched, parts, lines }
}

/** Nothing received yet. */
export const NO_READS = {
	touched: new Set(),
	parts: new Map(),
	lines: new Map(),
} as const satisfies ReadCoverage

/** The coverage paths the agent did not receive whole (`isWholeRead`), which the report counts. */
export function getUnreadPaths(
	reads: ReadCoverage,
	coverage: Pick<LoopCoverage<unknown>, 'paths' | 'changed'>
): string[] {
	return coverage.paths.filter(
		path => !isWholeRead(reads, path, coverage.changed.get(path))
	)
}

/** The coverage paths no tool call touched and the answer does not name, which get a continuation. */
export function getUntouchedPaths<TValue>(
	reads: ReadCoverage,
	coverage: LoopCoverage<TValue>,
	value: TValue
): string[] {
	const read = new Set([...reads.touched, ...coverage.answered(value)])
	return coverage.paths.filter(path => !read.has(path))
}

/** True when the parts of one section together hold every character of it. */
function isWhole(parts: readonly DiffPart[]): boolean {
	const size = parts[0]?.size ?? 0
	const reach = parts
		.toSorted((a, b) => a.from - b.from)
		.reduce(
			(covered, part) =>
				part.from <= covered ? Math.max(covered, part.to) : covered,
			0
		)
	return parts.length > 0 && reach >= size
}

/**
 * True when the agent received the whole change of `path`: every page of its diff section, or
 * `read_file` at the head showing every line in `changed` (empty for a file that deletes a line,
 * which only its diff shows). A partial read, one diff page, a blame or a finding on the path
 * never counts.
 */
export function isWholeRead(
	reads: ReadCoverage,
	path: string,
	changed: readonly number[] | undefined
): boolean {
	const diffRead = [...reads.parts.values()].some(
		parts => parts[0]?.path === path && isWhole(parts)
	)
	if (diffRead) return true
	const shown = reads.lines.get(path)
	const required = changed ?? []
	return required.length > 0 && required.every(line => shown?.has(line))
}
