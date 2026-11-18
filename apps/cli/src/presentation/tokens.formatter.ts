import type { TokensByModel, TokensBySource } from '@mng-review/engine'

/** One line per model: total, input (cached part), output and calls. */
export function toModelTokenLines(
	tokens: TokensByModel,
	indent: string
): string[] {
	return Object.entries(tokens).map(
		([model, entry]) =>
			`${indent}${model}  ${entry.totalTokens} (${entry.inputTokens} in, ${entry.cachedInputTokens} cached, ${entry.outputTokens} out, ${entry.calls} call(s))`
	)
}

/**
 * One line per finder or the validators: total, then input split into first messages re-sent per
 * call and grown history, output, calls and conversations.
 */
export function toSourceTokenLines(
	sources: TokensBySource,
	indent: string
): string[] {
	return Object.entries(sources).map(
		([source, entry]) =>
			`${indent}${source}  ${entry.totalTokens} (${entry.firstMessageTokens} first messages, ${entry.historyTokens} history, ${entry.cachedInputTokens} cached, ${entry.outputTokens} out, ${entry.calls} call(s), ${entry.conversations} conversation(s))`
	)
}
