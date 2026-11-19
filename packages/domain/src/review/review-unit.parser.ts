/** Most units one deep reviewer splits a change into; they run in parallel. */
export const MAX_REVIEW_UNITS = 8

/** A part of the change one deep-review sub-agent reviews: a function, handler or file group. */
export interface ReviewUnit {
	readonly label: string
	readonly paths: readonly string[]
	readonly diff: string
	/** Changed lines, used to balance groups. */
	readonly size: number
}

/** One hunk of a file diff and the function context git printed after its `@@` header. */
interface DiffHunk {
	readonly context: string
	readonly text: string
	readonly size: number
}

/** One file of a unified diff: its header lines and hunks. */
export interface FileDiff {
	readonly path: string
	readonly header: string
	readonly hunks: readonly DiffHunk[]
}

const FILE_START = /^(?=diff --git )/mu
const HUNK_CONTEXT = /^@@[^@]*@@ ?(.*)$/u
const GIT_HEADER_PATH = /^diff --git a\/.* b\/(.*)$/u

/** Git's C-style escapes in a quoted path: the character after the backslash and its byte. */
const ESCAPES = new Map([
	['a', 7],
	['b', 8],
	['t', 9],
	['n', 10],
	['v', 11],
	['f', 12],
	['r', 13],
	['"', 34],
	['\\', 92],
])
/** One escape (octal or single character) or a run of plain characters of a quoted path. */
const QUOTED_TOKEN = /\\[0-7]{3}|\\.|[^\\]+/gu

/** The bytes one token of a quoted path stands for. */
function toTokenBytes(token: string): number[] {
	if (!token.startsWith('\\')) return [...new TextEncoder().encode(token)]
	const escaped = token.slice(1)
	if (escaped.length === 3) return [Number.parseInt(escaped, 8)]
	return [ESCAPES.get(escaped) ?? escaped.codePointAt(0) ?? 0]
}

/**
 * A path as git prints it in a diff header, unquoted: git wraps a path with a quote, backslash or
 * control character in double quotes and escapes those bytes, octal escapes included.
 */
export function toUnquotedPath(text: string): string {
	if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"')))
		return text
	const tokens = text.slice(1, -1).match(QUOTED_TOKEN) ?? []
	return new TextDecoder().decode(new Uint8Array(tokens.flatMap(toTokenBytes)))
}

/** The path after a header prefix such as `+++ `, unquoted, without its `a/` or `b/` side. */
function getSidePath(line: string, prefix: string, side: string): string {
	const path = toUnquotedPath(line.slice(prefix.length).trimEnd())
	return path.startsWith(side) ? path.slice(side.length) : path
}

/** The file a diff block is about: the head path, else the base path or the rename target. */
function getHeaderPath(lines: readonly string[]): string {
	const plus = lines.find(line => /^\+\+\+ "?b\//u.test(line))
	if (plus) return getSidePath(plus, '+++ ', 'b/')
	const minus = lines.find(line => /^--- "?a\//u.test(line))
	if (minus) return getSidePath(minus, '--- ', 'a/')
	const renamed = lines.find(line => line.startsWith('rename to '))
	if (renamed)
		return toUnquotedPath(renamed.slice('rename to '.length).trimEnd())
	return GIT_HEADER_PATH.exec(lines[0]?.trimEnd() ?? '')?.[1] ?? 'unknown'
}

/** Splits hunk lines into hunks, counting `+` and `-` lines. */
function toHunks(lines: readonly string[]): DiffHunk[] {
	const hunks: DiffHunk[] = []
	for (const line of lines) {
		if (line.startsWith('@@')) {
			const context = HUNK_CONTEXT.exec(line.trimEnd())?.[1]?.trim() ?? ''
			hunks.push({ context, text: line, size: 0 })
			continue
		}
		const last = hunks.pop()
		if (!last) continue
		const changed = line.startsWith('+') || line.startsWith('-')
		hunks.push({
			...last,
			text: last.text + line,
			size: last.size + (changed ? 1 : 0),
		})
	}
	return hunks
}

/** Parses `git diff` output into files with their hunks. */
export function parseFileDiffs(diff: string): FileDiff[] {
	return diff
		.split(FILE_START)
		.filter(block => block.startsWith('diff --git '))
		.map(block => {
			const lines = block.split(/(?<=\n)/u)
			const firstHunk = lines.findIndex(line => line.startsWith('@@'))
			const headerLines = firstHunk === -1 ? lines : lines.slice(0, firstHunk)
			return {
				path: getHeaderPath(headerLines),
				header: headerLines.join(''),
				hunks: firstHunk === -1 ? [] : toHunks(lines.slice(firstHunk)),
			}
		})
}

/** A whole file as one unit. */
function toFileUnit(file: FileDiff): ReviewUnit {
	return {
		label: file.path,
		paths: [file.path],
		diff: file.header + file.hunks.map(hunk => hunk.text).join(''),
		size: file.hunks.reduce((sum, hunk) => sum + hunk.size, 0),
	}
}

/** One unit per function context in the file; hunks without one become their own unit. */
function toFunctionUnits(file: FileDiff): ReviewUnit[] {
	const groups = new Map<string, DiffHunk[]>()
	for (const [index, hunk] of file.hunks.entries()) {
		const key = hunk.context || `#${index}`
		groups.set(key, [...(groups.get(key) ?? []), hunk])
	}
	if (groups.size === 0) return [toFileUnit(file)]
	return [...groups].map(([key, hunks]) => ({
		label: key.startsWith('#') ? file.path : `${file.path}: ${key}`,
		paths: [file.path],
		diff: file.header + hunks.map(hunk => hunk.text).join(''),
		size: hunks.reduce((sum, hunk) => sum + hunk.size, 0),
	}))
}

/** The directory two paths share from the repository root, without a trailing slash. */
function getSharedDirectory(a: string, b: string): string {
	const left = a.split('/').slice(0, -1)
	const right = b.split('/').slice(0, -1)
	const differs = left.findIndex((segment, index) => segment !== right[index])
	return left.slice(0, differs === -1 ? left.length : differs).join('/')
}

/** Units in one group, named by the directory their paths share. */
function toGroupUnit(units: readonly ReviewUnit[]): ReviewUnit {
	const paths = units.flatMap(unit => unit.paths)
	const directory = getSharedDirectory(paths[0] ?? '', paths.at(-1) ?? '')
	return {
		label: directory
			? `${directory}/ (${paths.length} files)`
			: `${paths.length} files`,
		paths,
		diff: units.map(unit => unit.diff).join(''),
		size: units.reduce((sum, unit) => sum + unit.size, 0),
	}
}

/**
 * Packs file units into at most `max` groups of neighbouring paths: in path order, a group closes
 * once it holds its even share of the changed lines, so files of one directory stay together and
 * the groups stay about the same size.
 */
function packUnits(units: readonly ReviewUnit[], max: number): ReviewUnit[] {
	const sorted = units.toSorted((a, b) => {
		const left = a.paths[0] ?? ''
		const right = b.paths[0] ?? ''
		return left < right ? -1 : Number(left > right)
	})
	const total = sorted.reduce((sum, unit) => sum + unit.size, 0)
	const share = Math.max(1, Math.ceil(total / max))
	const groups = sorted.reduce<ReviewUnit[][]>((acc, unit) => {
		const current = acc.at(-1)
		const size = current?.reduce((sum, entry) => sum + entry.size, 0) ?? 0
		if (current && (size < share || acc.length >= max)) current.push(unit)
		else acc.push([unit])
		return acc
	}, [])
	return groups.map(toGroupUnit)
}

/**
 * Splits a unified diff into at most `max` units: one per enclosing function (the context after a
 * hunk's `@@` header), then one per file when there are too many, then files packed into `max`
 * groups of neighbouring paths.
 */
export function splitReviewUnits(
	diff: string,
	max: number = MAX_REVIEW_UNITS
): ReviewUnit[] {
	const files = parseFileDiffs(diff)
	const byFunction = files.flatMap(toFunctionUnits)
	if (byFunction.length <= max) return byFunction
	const byFile = files.map(toFileUnit)
	if (byFile.length <= max) return byFile
	return packUnits(byFile, max)
}
