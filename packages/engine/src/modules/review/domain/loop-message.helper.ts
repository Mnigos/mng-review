import { normalizeRepoPath } from '@mng-review/domain'
import { Predicate } from 'effect'
import type { Prompt, Response } from 'effect/ai'
import { MAX_LISTED_UNTOUCHED } from './review.constants'

type ToolCall = Response.ToolCallPart<string, unknown>

/** A tool message answering every call of a turn with its text, in order. */
export function toToolMessage(
	calls: readonly ToolCall[],
	outputs: readonly string[]
): Prompt.MessageEncoded {
	return {
		role: 'tool',
		content: calls.map((call, index) => ({
			type: 'tool-result',
			id: call.id,
			name: call.name,
			isFailure: false,
			result: outputs[index] ?? '',
			providerExecuted: false,
		})),
	}
}

/** A user message. */
export function toUserMessage(content: string): Prompt.MessageEncoded {
	return { role: 'user', content }
}

/** The repository path a tool call reads (`read_file`, `diff`, `blame`), normalised. */
export function getCallPath(call: ToolCall): string | undefined {
	const { params } = call
	if (!Predicate.hasProperty(params, 'path')) return undefined
	if (!Predicate.isString(params.path)) return undefined
	return normalizeRepoPath(params.path)
}

/**
 * The one continuation turn a finder gets when it answers before reading every changed file: the
 * files it left, at most `MAX_LISTED_UNTOUCHED` of them, and how to add what it finds.
 */
export function toContinuationMessage(
	untouched: readonly string[],
	finish: string
): string {
	const listed = untouched.slice(0, MAX_LISTED_UNTOUCHED)
	const rest = untouched.length - listed.length
	const more = rest > 0 ? `\n(and ${rest} more)` : ''
	return [
		'Before your answer counts: you have not read these changed files with a tool in this conversation.',
		`${listed.map(path => `- ${path}`).join('\n')}${more}`,
		`Read the diff or the file of each one and check its changed units as your method says. The findings you already reported are kept. Then call ${finish} again with only new findings, or an empty list.`,
	].join('\n')
}
