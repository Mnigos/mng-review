/** Characters GitHub's Markdown reads as syntax: emphasis, links, images, code, tables, headings and HTML. */
const MARKDOWN_SYNTAX = /[\\`*_[\]()!<>|#~&]/gu
/** Whitespace and control characters, so a lone carriage return or a line separator cannot end a line either. */
const LINE_BREAKS = /[\s\p{Cc}]+/gu
const BACKTICK_RUN = /`+/gu
/**
 * What GitHub turns into a link on its own: URLs with a scheme, `www.` hosts and e-mail addresses.
 * A scheme has at most 32 characters and an address starts only where its local part starts,
 * so a long word costs a bounded scan per position.
 */
const AUTOLINK =
	/(?:[a-z][a-z0-9+.-]{0,31}:\/\/|www\.)[^\s|`]+|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/giu
/** Control and format characters and line separators: they could end a log line, drive the terminal or reorder text. */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu

/** Escapes every Markdown syntax character with a backslash. */
function escapeSyntax(text: string): string {
	return text.replace(MARKDOWN_SYNTAX, '\\$&')
}

/**
 * Escapes text from a model or a repository for one line of GitHub Markdown: every syntax
 * character gets a backslash, line breaks become spaces, and anything GitHub would turn into a
 * link on its own becomes an inline code span. The text can neither format the page, start a
 * table cell, link anything nor open an HTML tag.
 */
export function escapeMarkdown(text: string): string {
	const flat = text.replace(LINE_BREAKS, ' ')
	const links = [...flat.matchAll(AUTOLINK)]
	const end = links.reduce(
		(state, match) => ({
			out: `${state.out}${escapeSyntax(flat.slice(state.from, match.index))}${toCodeSpan(match[0])}`,
			from: match.index + match[0].length,
		}),
		{ out: '', from: 0 }
	)
	return `${end.out}${escapeSyntax(flat.slice(end.from))}`
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

/**
 * Text that came from git, the endpoint or the repository, safe for one line of the job log: control
 * characters become spaces and the `::` and `##[` markers of workflow commands are broken up, so
 * the runner never reads the line as a command.
 */
export function toLogText(text: string): string {
	return text
		.replace(CONTROL_CHARACTERS, ' ')
		.replaceAll(/:(?=:)/gu, ': ')
		.replaceAll('##[', '## [')
}
