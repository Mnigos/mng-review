import { type EvidenceRef, normalizeRepoPath } from '@mng-review/domain'
import { Predicate } from 'effect'
import type { ToolOutput } from '../../review/application/agent-loop.types'
import {
	BlameTool,
	GrepTool,
	ReadFileTool,
} from '../../review/application/repo.toolkit'

/** Which tree a read showed: the head, or the merge base. */
export type ReadTree = 'head' | 'base'

/** The tool call fields a read is taken from. */
type ReadCall = Pick<ToolOutput['call'], 'name' | 'params'>

/** A `read_file` output line: `12| text`. */
const NUMBERED_LINE = /^(\d+)\| /u
/** A `grep` output line: `path:12:text`; a path with a colon is never evidence. */
const GREP_LINE = /^([^:\n]+):(\d+):/u
/** A `git blame --date=short` line: `sha [path] (author 2026-01-31 12) text`. */
const BLAME_LINE = /^\^?[0-9a-f]+ [^(]*\(.*? \d{4}-\d{2}-\d{2} +(\d+)\) /u

/** One shown line as a set key. */
function toReadKey(tree: ReadTree, path: string, line: number): string {
	return `${tree}\0${path}\0${line}`
}

/** The tree a call read; tools default to the head. */
function getCallTree(params: unknown): ReadTree {
	return Predicate.hasProperty(params, 'ref') && params.ref === 'base'
		? 'base'
		: 'head'
}

/** The normalised `path` parameter of a call. */
function getCallPath(params: unknown): string | undefined {
	if (!Predicate.hasProperty(params, 'path')) return undefined
	if (!Predicate.isString(params.path)) return undefined
	return normalizeRepoPath(params.path)
}

/** The line numbers a pattern's first group finds at the start of the output's lines. */
function getLineNumbers(output: string, pattern: RegExp): number[] {
	return output.split('\n').flatMap(line => {
		const number = pattern.exec(line)?.[1]
		return number === undefined ? [] : [Number(number)]
	})
}

/**
 * The lines a repository call showed the agent, as keys for `isRangeRead`: the numbered lines of a
 * `read_file`, the matches of a `grep` and the lines of a `blame` (always at the head). Any other
 * tool, and an output starting `error:`, shows none.
 */
export function getReadKeys(call: ReadCall, output: string): string[] {
	if (output.startsWith('error:')) return []
	const tree = getCallTree(call.params)
	if (call.name === GrepTool.name)
		return output.split('\n').flatMap(line => {
			const match = GREP_LINE.exec(line)
			const path = normalizeRepoPath(match?.[1] ?? '')
			if (!match || path === undefined) return []
			return [toReadKey(tree, path, Number(match[2]))]
		})
	const path = getCallPath(call.params)
	if (path === undefined) return []
	if (call.name === ReadFileTool.name)
		return getLineNumbers(output, NUMBERED_LINE).map(line =>
			toReadKey(tree, path, line)
		)
	if (call.name === BlameTool.name)
		return getLineNumbers(output, BLAME_LINE).map(line =>
			toReadKey('head', path, line)
		)
	return []
}

/**
 * True when every line of the entry's range was shown in that tree. It stops at the first line not
 * shown, so a huge cited range costs no more than the lines read.
 */
export function isRangeRead(
	reads: ReadonlySet<string>,
	tree: ReadTree,
	ref: EvidenceRef
): boolean {
	for (let line = ref.lines.start; line <= ref.lines.end; line++)
		if (!reads.has(toReadKey(tree, ref.path, line))) return false
	return true
}
