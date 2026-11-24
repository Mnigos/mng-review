import { MAX_TOOL_OUTPUT_CHARS } from './review.constants'

/** The note that ends a part of a long diff and names where the next one starts. */
function toNextPartNote(next: number): string {
	return `\n[more: call diff again with offset=${next}]`
}

/** A part of a long output: its text, and the characters of the whole output it holds. */
export interface OutputPage {
	readonly output: string
	/** Where the part starts in the whole output. */
	readonly start: number
	/** Where it ends, exclusive; the note naming the next part is not counted. */
	readonly end: number
}

/**
 * The part of a long diff from `offset`, cut on a line boundary to fit `MAX_TOOL_OUTPUT_CHARS`
 * with the note naming the next part's offset, so an agent can read past the first part. A
 * negative, fractional or non-finite offset from a model is clamped.
 */
export function toOutputPage(text: string, offset = 0): OutputPage {
	const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
	const rest = text.slice(start)
	if (start > 0 && rest.length === 0)
		return {
			output: `(no more output; it ends at offset ${text.length})`,
			start: text.length,
			end: text.length,
		}
	if (rest.length <= MAX_TOOL_OUTPUT_CHARS)
		return { output: rest, start, end: text.length }
	const room = MAX_TOOL_OUTPUT_CHARS - toNextPartNote(text.length).length
	const head = rest.slice(0, room)
	const lastLine = head.lastIndexOf('\n')
	const kept = lastLine > 0 ? head.slice(0, lastLine + 1) : head
	const end = start + kept.length
	return { output: kept + toNextPartNote(end), start, end }
}
