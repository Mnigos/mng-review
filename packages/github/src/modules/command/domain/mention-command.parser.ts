import { BOT_SLUG_PATTERN } from '@mng-review/domain'

/** An agent name a command may give: a letter or digit, then up to 63 word characters, dots or hyphens. */
const AGENT_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/u
/** A line that opens a fenced code block, once up to three leading spaces are gone. */
const FENCE = /^(`{3,}|~{3,})/u
/** A line that closes one: up to three spaces, fence characters and only whitespace after them. */
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u
/** An HTML comment, or one left open, which runs to the end of the comment body. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/gu
/** Indentation that makes an indented code block: a tab or four spaces. */
const CODE_INDENT = /^(?: {4}| {0,3}\t)/u
const LEADING_SPACES = /^ {0,3}/u
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

/** Where the scan is: inside a fence (its opening run) or inside a quoted paragraph. */
interface ScanState {
	readonly fence: string | undefined
	readonly quoted: boolean
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
	const lines = body.replace(HTML_COMMENT, '').split(/\r?\n/u)
	const state: { current: ScanState } = {
		current: { fence: undefined, quoted: false },
	}
	for (const raw of lines) {
		const { fence, quoted } = state.current
		if (fence !== undefined) {
			if (isClosingFence(raw, fence))
				state.current = { fence: undefined, quoted: false }
			continue
		}
		if (raw.trim() === '') {
			state.current = { fence: undefined, quoted: false }
			continue
		}
		const line = raw.replace(LEADING_SPACES, '')
		const [, opened] = FENCE.exec(line) ?? []
		if (opened !== undefined) {
			state.current = { fence: opened, quoted: false }
			continue
		}
		if (line.startsWith(QUOTE_START)) {
			state.current = { fence: undefined, quoted: true }
			continue
		}
		if (quoted || CODE_INDENT.test(raw)) continue
		const command = toLineCommand(line, mention)
		if (command) return command
	}
	return undefined
}
