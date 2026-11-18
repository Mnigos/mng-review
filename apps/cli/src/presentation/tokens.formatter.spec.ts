import type { TokensByModel, TokensBySource } from '@mng-review/engine'
import { toModelTokenLines, toSourceTokenLines } from './tokens.formatter'

const MODEL = {
	calls: 3,
	inputTokens: 90,
	cachedInputTokens: 40,
	outputTokens: 15,
	reasoningTokens: 5,
	totalTokens: 105,
} as const
const TOKENS = { 'model-a': MODEL } as const satisfies TokensByModel
const SOURCES = {
	reviewer: {
		...MODEL,
		conversations: 2,
		firstMessageTokens: 60,
		historyTokens: 30,
	},
} as const satisfies TokensBySource

test('model lines show cached input as part of input and preserve caller indentation', () =>
	expect(toModelTokenLines(TOKENS, '    ')).toEqual([
		'    model-a  105 (90 in, 40 cached, 15 out, 3 call(s))',
	]))
test('source lines show re-sent first messages, history, cache and conversation counts', () =>
	expect(toSourceTokenLines(SOURCES, '  source  ')).toEqual([
		'  source  reviewer  105 (60 first messages, 30 history, 40 cached, 15 out, 3 call(s), 2 conversation(s))',
	]))
test('empty model and source ledgers produce no lines', () => {
	expect(toModelTokenLines({}, '')).toEqual([])
	expect(toSourceTokenLines({}, '')).toEqual([])
})
