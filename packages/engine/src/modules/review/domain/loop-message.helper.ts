import type { Prompt, Response } from 'effect/ai'
import type { UnreadFile, UnreadReason } from './review-report.types'
import { MAX_CONTINUATION_PATHS } from './review.constants'

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

/** How a continuation names why a file counts as unread. */
const UNREAD_NOTE = {
	untouched: 'not read',
	partial: 'only part of its diff came back',
	deletions:
		'read with read_file, which never shows the lines the change deletes',
} as const satisfies Record<UnreadReason, string>

/**
 * The one continuation turn a finder gets when it answers before receiving every changed file
 * whole: the files it left, at most `MAX_CONTINUATION_PATHS` of them with the reason each counts as
 * unread, how to read them with `diff` and how to add what it finds.
 */
export function toContinuationMessage(
	unread: readonly UnreadFile[],
	finish: string
): string {
	const listed = unread.slice(0, MAX_CONTINUATION_PATHS)
	const rest = unread.length - listed.length
	const more = rest > 0 ? `\n(and ${rest} more)` : ''
	return [
		'Before your answer counts: you have not received the whole diff of these changed files in this conversation.',
		`${listed.map(file => `- ${file.path} (${UNREAD_NOTE[file.reason]})`).join('\n')}${more}`,
		`Read each one with \`diff(path)\`, every part of it: a long diff comes in parts, and the end of each part names the offset of the next. Call several in one turn. \`read_file\` does not count for these files. Check their changed units as your method says. The findings you already reported are kept. Then call ${finish} again with only new findings, or an empty list.`,
	].join('\n')
}
