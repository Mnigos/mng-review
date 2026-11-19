/** A `/mng-review` line: alone on its line, optionally followed by `deep` or one agent name. */
const COMMAND_LINE = /^\/mng-review(?:[ \t]+([A-Za-z0-9][\w.-]{0,63}))?$/u
/** A line that opens or closes a fenced code block. */
const FENCE = /^(`{3,}|~{3,})/u
export const DEEP_ARGUMENT = 'deep'

/** What a command asks for: a review, at deep depth, or by one named agent. */
export interface ReviewCommand {
	readonly depth?: 'deep'
	readonly agent?: string
}

/** The command a matched line asks for. */
function toCommand(argument: string | undefined): ReviewCommand {
	if (argument === undefined) return {}
	if (argument === DEEP_ARGUMENT) return { depth: 'deep' }
	return { agent: argument }
}

/** True when the line closes the block the fence opened: the same character, at least as long. */
function isClosingFence(line: string, open: string): boolean {
	const [, fence] = FENCE.exec(line) ?? []
	return (
		fence !== undefined &&
		fence.startsWith(open.charAt(0)) &&
		fence.length >= open.length
	)
}

/**
 * The first `/mng-review` command of a comment, or `undefined` when there is none. A command is a
 * line that holds only the command and its argument; lines inside fenced code blocks and quotes do
 * not count, so a command quoted in a reply or an example never runs.
 */
export function parseReviewCommand(body: string): ReviewCommand | undefined {
	const state: { fence: string | undefined } = { fence: undefined }
	for (const raw of body.split(/\r?\n/u)) {
		const line = raw.trim()
		if (state.fence !== undefined) {
			if (isClosingFence(line, state.fence)) state.fence = undefined
			continue
		}
		const [, fence] = FENCE.exec(line) ?? []
		if (fence !== undefined) {
			state.fence = fence
			continue
		}
		const [matched, argument] = COMMAND_LINE.exec(line) ?? []
		if (matched !== undefined) return toCommand(argument)
	}
	return undefined
}
