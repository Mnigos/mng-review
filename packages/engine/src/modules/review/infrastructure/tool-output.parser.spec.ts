import {
	MAX_GREP_LINES,
	MAX_TOOL_OUTPUT_CHARS,
} from '../domain/review.constants'
import { addGrepMatch, addNumberedLine } from './tool-output.parser'

const EMPTY_LINES = { text: '', seen: 0, binary: false, whole: 0 } as const
const EMPTY_MATCHES = { text: '', shown: 0, rest: 0 } as const

describe('addNumberedLine', () => {
	test('keeps only the range and still counts and checks every line', () => {
		expect(
			['one', 'two', 'three', 'four\0'].reduce(
				addNumberedLine({ start: 2, end: 3 }),
				EMPTY_LINES
			)
		).toEqual({ text: '2| two\n3| three', seen: 4, binary: true, whole: 3 })
	})
	test('stops keeping lines once the kept text passes the output cap', () => {
		const line = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS)
		const state = [line, line, line].reduce(
			addNumberedLine(undefined),
			EMPTY_LINES
		)
		expect(state.seen).toBe(3)
		expect(state.text).toBe(`1| ${line}`)
	})
})

describe('addGrepMatch', () => {
	test('drops the commit prefix and records outside the glob', () => {
		expect(
			[
				'head:src/a.ts\u00002\u0000const a = 1',
				'head:docs/a.md\u00001\u0000a',
				'',
			].reduce(addGrepMatch('head', 'src/**'), EMPTY_MATCHES)
		).toEqual({ text: 'src/a.ts:2:const a = 1', shown: 1, rest: 0 })
	})
	test('counts matches past MAX_GREP_LINES without keeping them', () => {
		const state = Array.from(
			{ length: MAX_GREP_LINES + 5 },
			(_, index) => `head:a.ts\u0000${index + 1}\u0000needle`
		).reduce(addGrepMatch('head', undefined), EMPTY_MATCHES)
		expect(state.shown).toBe(MAX_GREP_LINES)
		expect(state.rest).toBe(5)
		expect(state.text.split('\n')).toHaveLength(MAX_GREP_LINES)
	})
})
