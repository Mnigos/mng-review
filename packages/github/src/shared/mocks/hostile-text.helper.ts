/** Model text spans mentions, code fences, references, HTML, table syntax and bidi controls. */
export const HOSTILE_TEXT =
	'@octocat `@org/team ` #12 <img src=x> </details> --> 0123456789abcdef0123456789abcdef01234567 | table | \u202E'

/** A fenced code block: its opening fence and info string, its lines, and a closing fence as long. */
const CODE_BLOCK = /^(`{3,})([^\n`]*)\n([\s\S]*?)\n?^\1$/gmu

/** Fenced code blocks of a comment, with their fence and info string; Markdown renders nothing inside. */
export function getCodeBlocks(text: string) {
	return Array.from(
		text.matchAll(CODE_BLOCK),
		([, fence = '', info = '', body = '']) => ({
			fence,
			info,
			body,
		})
	)
}

/** A comment without its fenced code blocks: the text Markdown renders. */
export function toTextOutsideCode(text: string): string {
	return text.replaceAll(CODE_BLOCK, '')
}
