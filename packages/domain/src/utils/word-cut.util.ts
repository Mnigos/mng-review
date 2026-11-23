/** Whitespace, commas, semicolons and colons a cut text should not end on before its ellipsis. */
const TRAILING_BREAK = /[\s,;:]+$/u
/** A high surrogate a hard cut left without its pair. */
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF]$/u

/**
 * Text of at most `max` characters: unchanged when it fits, otherwise cut at the last word
 * boundary that keeps it within `max` and ended with `…`. A text with no boundary in its second
 * half is cut mid-word instead, so a long token never shrinks to a stub.
 */
export function toWordCut(text: string, max: number): string {
	if (text.length <= max) return text
	const head = text.slice(0, Math.max(0, max - 1))
	const boundary = head.search(/\s\S*$/u)
	const cut = boundary > head.length / 2 ? head.slice(0, boundary) : head
	return `${cut.replace(LONE_HIGH_SURROGATE, '').replace(TRAILING_BREAK, '')}…`
}
