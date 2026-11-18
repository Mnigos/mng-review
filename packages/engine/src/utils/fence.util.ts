const BACKTICK_RUN = /`+/gu
/** A fence must open with at least three backticks. */
const MIN_FENCE_LENGTH = 3

/**
 * Wraps untrusted text (change content, tool output) under a label in a code fence longer than any
 * backtick run inside it, so the model can tell data from instructions.
 */
export function fenceData(label: string, text: string): string {
	const longest = Math.max(
		MIN_FENCE_LENGTH - 1,
		...Array.from(text.matchAll(BACKTICK_RUN), match => match[0].length)
	)
	const fence = '`'.repeat(longest + 1)
	return `${label}\n${fence}text\n${text}\n${fence}`
}

/** The marker that replaces the cut part of a truncated text. */
function toTruncationMarker(rest: number): string {
	return `\n[truncated: ${rest} more characters]`
}

/** Cuts text to at most `maxChars` characters, the cut marker included. */
export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	const keep = Math.max(0, maxChars - toTruncationMarker(text.length).length)
	return `${text.slice(0, keep)}${toTruncationMarker(text.length - keep)}`.slice(
		0,
		maxChars
	)
}
