import { Option, Schema } from 'effect'

const decodeJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Unknown)
)
/** The first fenced block, with or without a language tag. */
const FENCED_BLOCK = /(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1/u

/**
 * The JSON value of a plain-text answer: the whole text, else its first fenced block, else the part
 * from the first `{` to the last `}`. `undefined` when none of them is JSON.
 */
export function parseAnswerJson(text: string): unknown {
	const trimmed = text.trim()
	if (!trimmed) return undefined
	const fenced = FENCED_BLOCK.exec(trimmed)?.[2]
	const start = trimmed.indexOf('{')
	const end = trimmed.lastIndexOf('}')
	const candidates = [
		trimmed,
		...(fenced === undefined ? [] : [fenced.trim()]),
		...(start !== -1 && end > start ? [trimmed.slice(start, end + 1)] : []),
	]
	for (const candidate of candidates) {
		const value = decodeJson(candidate)
		if (Option.isSome(value)) return value.value
	}
	return undefined
}
