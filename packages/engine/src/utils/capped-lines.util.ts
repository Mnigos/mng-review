import { Stream } from 'effect'

/** Cuts a line to `maxChars`; a NUL in the cut part stays as one trailing NUL, so binary checks see it. */
function capLine(line: string, maxChars: number): string {
	if (line.length <= maxChars) return line
	return `${line.slice(0, maxChars)}${line.includes('\0', maxChars) ? '\0' : ''}`
}

/**
 * Splits a text stream on `\n` and cuts every line to `maxChars` (plus a NUL marker, see `capLine`)
 * while it streams, so neither the whole text nor one long line is ever held. A final `\n` ends the
 * last line; no empty line follows.
 */
export function splitCappedLines<TError, TContext>(
	text: Stream.Stream<string, TError, TContext>,
	maxChars: number
): Stream.Stream<string, TError, TContext> {
	return Stream.mapAccum(
		text,
		() => '',
		(open: string, chunk: string) => {
			const lines = `${open}${chunk}`.split('\n')
			const rest = lines.pop() ?? ''
			return [
				capLine(rest, maxChars),
				lines.map(line => capLine(line, maxChars)),
			] as const
		},
		{ onHalt: open => (open === '' ? [] : [open]) }
	)
}
