/** Characters GitHub's Markdown reads as syntax: emphasis, links, images, code, tables, headings and HTML. */
const MARKDOWN_SYNTAX = /[\\`*_[\]()!<>|#~&]/gu
/** Whitespace and control characters, so a lone carriage return or a line separator cannot end a line either. */
const LINE_BREAKS = /[\s\p{Cc}]+/gu
const BACKTICK_RUN = /`+/gu
/**
 * What GitHub turns into a link or a notification on its own: URLs with a scheme, `www.` hosts,
 * e-mail addresses, `@` mentions of users and teams, issue references (`#12`, `owner/repo#12`,
 * `GH-12`), which also notify the referenced issue, and commit references (a SHA of 7 to 40 hex
 * characters, `owner/repo@sha`, `sha...sha`). A scheme has at most 32 characters and an address
 * starts only where its local part starts, so a long word costs a bounded scan per position.
 */
const AUTOLINK =
	/(?:[a-z][a-z0-9+.-]{0,31}:\/\/|www\.)[^\s|`]+|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<!\w)@[a-z0-9][\w-]*(?:\/[\w.-]+)?|(?<!\w)(?:[\w.-]+\/[\w.-]+)?#\d+|\bgh-\d+\b|(?<!\w)(?:[\w.-]+\/[\w.-]+@)?[0-9a-f]{7,40}(?:\.{2,3}[0-9a-f]{7,40})?(?!\w|:\/\/)/giu
/** Format characters (bidirectional overrides, zero-width marks), which could make text read in another order. */
const FORMAT_CHARACTERS = /\p{Cf}+/gu
/** A start GitHub reads as a list item, a heading underline or a rule: `-`, `+` or `=`. */
const BULLET_START = /^(\s*)([-+=])/u
/** A start GitHub reads as a numbered list item: `1.` or `1)`. */
const NUMBER_START = /^(\s*\d+)([.)])/u

/** Control and format characters and line separators: they could end a log line, drive the terminal or reorder text. */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu

/** Escapes every Markdown syntax character with a backslash. */
function escapeSyntax(text: string): string {
	return text.replace(MARKDOWN_SYNTAX, '\\$&')
}

/**
 * Escapes text from a model or a repository for one line of GitHub Markdown: every syntax
 * character gets a backslash, line breaks become spaces, and anything GitHub would turn into a
 * link, a mention or an issue or commit reference on its own becomes an inline code span. Format
 * characters are dropped and a list or rule marker at the start is escaped. The text can neither
 * format the page, start a table cell or a list, link anything, notify anyone nor open an HTML tag.
 */
export function escapeMarkdown(text: string): string {
	const flat = text.replace(FORMAT_CHARACTERS, '').replace(LINE_BREAKS, ' ')
	const links = [...flat.matchAll(AUTOLINK)]
	const end = links.reduce(
		(state, match) => ({
			out: `${state.out}${escapeSyntax(flat.slice(state.from, match.index))}${toCodeSpan(match[0])}`,
			from: match.index + match[0].length,
		}),
		{ out: '', from: 0 }
	)
	return `${end.out}${escapeSyntax(flat.slice(end.from))}`
		.replace(BULLET_START, String.raw`$1\$2`)
		.replace(NUMBER_START, String.raw`$1\$2`)
}

/**
 * Text as an inline code span outside a table, with a fence longer than any backtick run inside
 * it, line breaks as spaces and format characters dropped. Nothing inside a code span is read as
 * Markdown or HTML, and its text cannot be shown in another order.
 */
export function toCodeSpan(text: string): string {
	const flat = text.replace(FORMAT_CHARACTERS, '').replace(LINE_BREAKS, ' ')
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
