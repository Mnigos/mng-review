/** Characters GitHub's Markdown reads as syntax: emphasis, links, images, code, tables, headings and HTML. */
const MARKDOWN_SYNTAX = /[\\`*_[\]()!<>|#~&]/gu
const LINE_BREAKS = /\s*\r?\n\s*/gu
const BACKTICK_RUN = /`+/gu

/**
 * Escapes text from a model or a repository for one line of GitHub Markdown: every syntax
 * character gets a backslash and line breaks become spaces, so the text can neither format the
 * page, start a table cell, link an image nor open an HTML tag.
 */
export function escapeMarkdown(text: string): string {
	return text.replace(LINE_BREAKS, ' ').replace(MARKDOWN_SYNTAX, '\\$&')
}

/**
 * Text as an inline code span outside a table, with a fence longer than any backtick run inside
 * it and line breaks as spaces. Nothing inside a code span is read as Markdown or HTML.
 */
export function toCodeSpan(text: string): string {
	const flat = text.replace(LINE_BREAKS, ' ')
	const longest = Math.max(
		0,
		...Array.from(flat.matchAll(BACKTICK_RUN), match => match[0].length)
	)
	const fence = '`'.repeat(longest + 1)
	const padding = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
	return `${fence}${padding}${flat}${padding}${fence}`
}
