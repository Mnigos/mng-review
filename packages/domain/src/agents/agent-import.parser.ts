import { Effect } from 'effect'
import { ConfigError } from '../config/config.errors'
import { normalizeRepoPath } from '../utils/repo-path.util'
import type { AgentImport } from './agent.types'

/** A line that is only `@/path` or `@/path#Heading`. */
const IMPORT_LINE = /^@\/([^\s#][^#]*?)(?:#(.+))?$/u
/** An ATX heading; closing `#`s count only when whitespace separates them, so `## C#` keeps its `#`. */
const HEADING_LINE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u
/** An opening code fence; a backtick fence's info string has no backticks. */
const OPENING_FENCE = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/u
/** A closing code fence: only the marker and trailing whitespace. */
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u

/** A heading outside fenced code. */
interface Heading {
	readonly index: number
	readonly level: number
	readonly text: string
}

/** Where a heading scan stands: the open fence marker, if any, and the headings so far. */
interface HeadingScan {
	readonly fence: string | undefined
	readonly headings: readonly Heading[]
}

/**
 * Parses an import line. Returns `undefined` for any other line, including an inline mention, and
 * fails for a path outside the repository.
 */
export function parseImportLine(
	line: string,
	source: string
): Effect.Effect<AgentImport | undefined, ConfigError> {
	const trimmed = line.trim()
	const match = IMPORT_LINE.exec(trimmed)
	if (!match?.[1]) return Effect.succeed(undefined)
	const path = normalizeRepoPath(match[1].trim())
	if (path === undefined || path === '.')
		return Effect.fail(
			new ConfigError({
				source,
				reason: `import "${trimmed}" points outside the repository`,
			})
		)
	const heading = match[2]?.trim()
	return Effect.succeed(heading === undefined ? { path } : { path, heading })
}

/** True when the line closes a fence opened with `fence`: same marker, at least as long. */
function isClosingFence(line: string, fence: string): boolean {
	const marker = CLOSING_FENCE.exec(line)?.[1]
	return (
		marker !== undefined &&
		marker.startsWith(fence.charAt(0)) &&
		marker.length >= fence.length
	)
}

/** Headings outside fenced code blocks, in order. */
function getHeadings(lines: readonly string[]): readonly Heading[] {
	return lines.reduce<HeadingScan>(
		(scan, line, index) => {
			if (scan.fence !== undefined)
				return isClosingFence(line, scan.fence)
					? { ...scan, fence: undefined }
					: scan
			const opening = OPENING_FENCE.exec(line)
			const fence = opening?.[1] ?? opening?.[2]
			if (fence) return { ...scan, fence }
			const heading = HEADING_LINE.exec(line)
			if (!heading?.[1]) return scan
			return {
				...scan,
				headings: [
					...scan.headings,
					{ index, level: heading[1].length, text: heading[2] ?? '' },
				],
			}
		},
		{ fence: undefined, headings: [] }
	).headings
}

/**
 * Returns the section from the heading with the given text to the next heading of the same or a
 * higher level, nested headings included, or `undefined` when no heading has that text. Headings
 * inside fenced code are ignored.
 */
export function extractSection(
	markdown: string,
	heading: string
): string | undefined {
	const lines = markdown.split(/\r?\n/u)
	const headings = getHeadings(lines)
	const startIndex = headings.findIndex(entry => entry.text === heading)
	const start = headings[startIndex]
	if (!start) return undefined
	const end = headings
		.slice(startIndex + 1)
		.find(entry => entry.level <= start.level)
	return lines.slice(start.index, end?.index).join('\n').trimEnd()
}
