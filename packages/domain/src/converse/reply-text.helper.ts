/** Whitespace runs, line breaks included. */
const WHITESPACE = /\s+/gu
/** Anything but letters, digits, spaces and punctuation that opens no link, image, code, HTML or mention. */
const UNSAFE_CHARS = /[^\p{L}\p{N} .,;:'"/_\-()]/gu
/** A URL scheme's separator, which GitHub autolinks. */
const SCHEME_SEPARATOR = /:\/\//gu
/** `www.`, which GitHub autolinks at a word's start; broken wherever it stands. */
const WWW_PREFIX = /(www)\./giu

/** The text on one line with its whitespace runs collapsed. */
export function toOneLine(text: string): string {
	return text.replace(WHITESPACE, ' ').trim()
}

/** The text on one line, cut to `maxChars` characters with an ellipsis when it is longer. */
export function toCutLine(text: string, maxChars: number): string {
	const line = toOneLine(text)
	if (line.length <= maxChars) return line
	return `${line.slice(0, maxChars - 1).trimEnd()}…`
}

/**
 * The text as plain text: every character but letters, digits, spaces and `. , ; : ' " / _ - ( )`
 * becomes a space, and `://` and a leading `www.` are broken, so Markdown renders no link, image,
 * code, HTML or mention in it.
 */
export function toPlainText(text: string): string {
	return text
		.replace(UNSAFE_CHARS, ' ')
		.replace(SCHEME_SEPARATOR, ': //')
		.replace(WWW_PREFIX, '$1 ')
}
