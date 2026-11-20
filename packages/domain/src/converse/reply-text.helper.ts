/** Whitespace runs, line breaks included. */
const WHITESPACE = /\s+/gu
/**
 * Anything but letters, digits, spaces and punctuation that opens no link, image, code, HTML,
 * mention or emphasis.
 */
const UNSAFE_CHARS = /[^\p{L}\p{N} .,;:'"/\-()]/gu
/** A URL scheme's separator, which GitHub autolinks. */
const SCHEME_SEPARATOR = /:\/\//gu
/** `www.`, which GitHub autolinks at a word's start; broken wherever it stands. */
const WWW_PREFIX = /(www)\./giu
/** `GH-1` and `GHSA-…`, which GitHub links to an issue or an advisory. */
const GITHUB_REFERENCE = /\b(GH|GHSA)-/giu
/** A word of 7 or more hex characters, which GitHub links when it names a commit; a rare word splits too. */
const COMMIT_LIKE = /\b[0-9a-f]{7,}\b/giu
/** Each 6 characters of a hex run that more characters follow, so no piece is long enough to link. */
const HEX_PIECE = /[0-9a-f]{6}(?=[0-9a-f])/giu

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
 * The text as plain text: every character but letters, digits, spaces and `. , ; : ' " / - ( )`
 * becomes a space, `://`, `www.`, `GH-` and `GHSA-` are broken, and a hex word of 7 or more
 * characters is split into pieces of at most 6, so GitHub renders no link, image, code, HTML,
 * mention, emphasis or reference in it.
 */
export function toPlainText(text: string): string {
	return text
		.replace(UNSAFE_CHARS, ' ')
		.replace(SCHEME_SEPARATOR, ': //')
		.replace(WWW_PREFIX, '$1 ')
		.replace(GITHUB_REFERENCE, '$1 ')
		.replace(COMMIT_LIKE, run => run.replace(HEX_PIECE, '$& '))
}
