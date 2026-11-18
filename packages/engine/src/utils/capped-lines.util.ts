import { Stream } from 'effect'

/**
 * Splits a text stream on `\n` and cuts every line to `maxChars` while it streams, so neither the
 * whole text nor one long line is ever held. A final `\n` ends the last line; no empty line follows.
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
				rest.slice(0, maxChars),
				lines.map(line => line.slice(0, maxChars)),
			] as const
		},
		{ onHalt: open => (open === '' ? [] : [open]) }
	)
}
