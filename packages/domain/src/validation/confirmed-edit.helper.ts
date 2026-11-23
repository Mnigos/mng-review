import type { ConfirmedEdit } from './validation.types'
import type { Verdict } from './verdict.schema'

/** Most characters of a suggested replacement; a longer fix is not one small edit. */
export const MAX_EDIT_CHARS = 2000
/** Most lines of a suggested replacement. */
export const MAX_EDIT_LINES = 20
/**
 * Control characters other than tab and line feed, format characters (bidirectional overrides,
 * zero-width marks) and line separators: code that holds one could read differently from what runs.
 */
const HIDDEN_CHARACTERS = /[^\P{Cc}\t\n]|[\p{Cf}\p{Zl}\p{Zp}]/u
/** A line copied with the number a `read_file` result puts before it. */
const NUMBERED_LINE = /^\d+\| /u

/** What `toConfirmedEdit` checks a validator's fix against. */
export interface EditInput {
	readonly verdict: Pick<Verdict, 'verdict' | 'edit'>
	/** The finding's line at head, the line its comment sits on. */
	readonly line: number
	/** The head commit the file was read at. */
	readonly commit: string
	/** The finding's file at the head; `undefined` when it is not there. */
	readonly headText: string | undefined
}

/** True when code holds only printable characters, tabs and line feeds. */
export function isPlainCode(text: string): boolean {
	return !HIDDEN_CHARACTERS.test(text)
}

/** A line without its carriage return and trailing whitespace, as two copies of it compare. */
function toComparable(line: string): string {
	return line.replace(/\r$/u, '').trimEnd()
}

/**
 * The validator's fix as an edit a comment may suggest, or `undefined`. It must come with a
 * confirmation, name the finding's line by its exact text at the head, change it, hold plain code
 * only, and stay within `MAX_EDIT_CHARS` and `MAX_EDIT_LINES`; a line at the head longer than
 * `MAX_EDIT_CHARS` gets no edit. A replacement copied with
 * `read_file` line numbers is refused, since it would put the numbers into the code.
 */
export function toConfirmedEdit(input: EditInput): ConfirmedEdit | undefined {
	const { verdict, line, commit, headText } = input
	const { edit } = verdict
	if (verdict.verdict !== 'confirm' || !edit || headText === undefined)
		return undefined
	const current = line >= 1 ? headText.split('\n')[line - 1] : undefined
	// The original travels in the outcome file, whose fields are capped; a longer line gets no edit.
	if (current === undefined || current.length > MAX_EDIT_CHARS) return undefined
	if (toComparable(current) !== toComparable(edit.line)) return undefined
	const replacement = edit.replacement.replace(/\n$/u, '')
	const lines = replacement.split('\n')
	if (toComparable(replacement) === toComparable(current)) return undefined
	if (!isPlainCode(replacement) || replacement.length > MAX_EDIT_CHARS)
		return undefined
	if (lines.length > MAX_EDIT_LINES) return undefined
	if (lines.every(entry => NUMBERED_LINE.test(entry))) return undefined
	return { commit, line, original: current, replacement }
}
