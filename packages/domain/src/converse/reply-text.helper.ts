/** Whitespace runs, line breaks included. */
const WHITESPACE = /\s+/gu
/** Characters that could open markup, a code span or a mention wherever the text is rendered. */
const MARKUP_CHARS = /[<>`@]/gu

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

/** The text without `<`, `>`, backticks and `@`, so no later rendering reads markup or a mention in it. */
export function toPlainText(text: string): string {
	return text.replace(MARKUP_CHARS, '')
}
