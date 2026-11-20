import { BOT_SLUG_PATTERN } from '@mng-review/domain'

/** An agent name a command may give: a letter or digit, then up to 63 word characters, dots or hyphens. */
const AGENT_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/u
/** A line that opens a fenced code block, once up to three leading spaces are gone. */
const FENCE = /^(`{3,}|~{3,})/u
/** A line that closes one: up to three spaces, fence characters and only whitespace after them. */
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u
/**
 * An HTML comment on one line; the group is empty when it is left open at the end of the line.
 * `s` lets it run over a bare CR, U+2028 or U+2029 inside the line.
 */
const HTML_COMMENT = /<!--.*?(-->|$)/gsu
const COMMENT_CLOSE = '-->'
/** Indentation that makes an indented code block: a tab or four spaces. */
const CODE_INDENT = /^(?: {4}| {0,3}\t)/u
const LEADING_SPACES = /^ {0,3}/u
/** List item markers at the start of a line, nested ones included: `-`, `*`, `+`, `1.` or `1)`. */
const LIST_MARKERS = /^(?: {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)+/u
/** A blank line: spaces and tabs only, as Markdown counts it (a no-break space is not blank). */
const BLANK_LINE = /^[ \t]*$/u
/** Line breaks as Markdown reads them: CRLF, a bare CR or LF. */
const LINE_BREAK = /\r\n?|\n/u
const TRAILING_BLANKS = /[ \t]+$/u
const WORD_SEPARATOR = /[ \t]+/u
/** A command line has at most four words: the mention, the verb and up to two more. */
const MAX_WORDS = 4
const QUOTE_START = '>'

/** What a command asks for: a review, at a requested depth, or by one named agent. */
export interface ReviewCommand {
	readonly depth?: 'deep' | 'quick'
	readonly agent?: string
}

/**
 * Where the scan is: inside a fence (its opening run), inside a quoted paragraph, inside an HTML
 * comment. A quote outlives the fences inside it and ends only at a blank line outside code.
 */
interface ScanState {
	readonly fence: string | undefined
	readonly quoted: boolean
	readonly inComment: boolean
	/** The last line was paragraph text, so an indented line continues it instead of starting code. */
	readonly afterText: boolean
}

/** The text of one line outside HTML comments, and whether a comment is still open at its end. */
interface VisibleLine {
	readonly text: string
	readonly inComment: boolean
}

/** The part of a line no HTML comment hides; a comment left open runs on to the next lines. */
function toVisibleLine(line: string, inComment: boolean): VisibleLine {
	if (inComment) {
		const close = line.indexOf(COMMENT_CLOSE)
		if (close === -1) return { text: '', inComment: true }
		return toVisibleLine(line.slice(close + COMMENT_CLOSE.length), false)
	}
	const last = [...line.matchAll(HTML_COMMENT)].at(-1)
	return {
		text: line.replace(HTML_COMMENT, ''),
		inComment: last !== undefined && last[1] === '',
	}
}

/** The fence a line opens, or `undefined`; a backtick fence whose info string holds a backtick opens none. */
function getOpenedFence(line: string): string | undefined {
	const trimmed = line.replace(LIST_MARKERS, '').replace(LEADING_SPACES, '')
	const [, fence] = FENCE.exec(trimmed) ?? []
	if (fence === undefined) return undefined
	if (fence.startsWith('`') && trimmed.slice(fence.length).includes('`'))
		return undefined
	return fence
}

/** True when the line closes the block the fence opened: the same character, at least as long. */
function isClosingFence(line: string, open: string): boolean {
	const [, fence] = CLOSING_FENCE.exec(line) ?? []
	return (
		fence !== undefined &&
		fence.startsWith(open.charAt(0)) &&
		fence.length >= open.length
	)
}

/** The command the words after the mention ask for; `review` and its depths, or `run <agent>`. */
function toCommand(words: readonly string[]): ReviewCommand | undefined {
	const [verb, argument, extra] = words
	if (extra !== undefined) return undefined
	if (verb === 'review') {
		if (argument === undefined) return {}
		if (argument === 'deep' || argument === 'quick') return { depth: argument }
		return undefined
	}
	if (verb === 'run' && argument !== undefined && AGENT_NAME.test(argument))
		return { agent: argument }
	return undefined
}

/** The command one line holds, its leading spaces already removed, or `undefined`. */
function toLineCommand(
	line: string,
	mention: string
): ReviewCommand | undefined {
	const words = line.replace(TRAILING_BLANKS, '').split(WORD_SEPARATOR)
	const [first, ...rest] = words
	if (words.length > MAX_WORDS || first?.toLowerCase() !== mention)
		return undefined
	return toCommand(rest)
}

/**
 * The first command of a comment that mentions `@<handle>`, or `undefined` when there is none or
 * the handle is not a slug. A command line holds only the mention and its words. Lines inside HTML
 * comments, fenced or indented code, quotes and the paragraph a quote runs on into never count, so
 * a command quoted in a reply, shown as an example or hidden from the rendered comment never runs.
 */
export function parseMentionCommand(
	body: string,
	handle: string
): ReviewCommand | undefined {
	if (!BOT_SLUG_PATTERN.test(handle)) return undefined
	const mention = `@${handle.toLowerCase()}`
	const lines = body.split(LINE_BREAK)
	const state: { current: ScanState } = {
		current: {
			fence: undefined,
			quoted: false,
			inComment: false,
			afterText: false,
		},
	}
	for (const raw of lines) {
		const { fence, quoted, inComment, afterText } = state.current
		if (fence !== undefined) {
			if (isClosingFence(raw, fence))
				state.current = { ...state.current, fence: undefined }
			continue
		}
		if (!inComment) {
			if (BLANK_LINE.test(raw)) {
				state.current = { ...state.current, quoted: false, afterText: false }
				continue
			}
			const opened = getOpenedFence(raw)
			if (opened !== undefined) {
				state.current = { ...state.current, fence: opened, afterText: false }
				continue
			}
			// Indented code shows `<!--` as text, so it never opens a comment that could hide a fence;
			// after paragraph text an indented line only continues the paragraph.
			if (CODE_INDENT.test(raw) && !afterText) continue
		}
		const visible = toVisibleLine(raw, inComment)
		state.current = { ...state.current, inComment: visible.inComment }
		if (visible.text.trim() === '') continue
		state.current = { ...state.current, afterText: true }
		const line = visible.text.replace(LEADING_SPACES, '')
		// A quote inside a list item still quotes what follows it.
		if (line.replace(LIST_MARKERS, '').startsWith(QUOTE_START)) {
			state.current = { ...state.current, quoted: true }
			continue
		}
		if (quoted || CODE_INDENT.test(visible.text)) continue
		const command = toLineCommand(line, mention)
		if (command) return command
	}
	return undefined
}
