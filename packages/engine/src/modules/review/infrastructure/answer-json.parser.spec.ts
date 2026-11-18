import { parseAnswerJson } from './answer-json.parser'

describe('parseAnswerJson', () => {
	test.each([
		'{"findings":[]}',
		'```json\n{"findings":[]}\n```',
		'```\n{"findings":[]}\n```',
		'~~~~json\n{"findings":[]}\n~~~~',
		'Answer: {"findings":[]} done.',
	])('reads %s', text => {
		expect(parseAnswerJson(text)).toEqual({ findings: [] })
	})
	test.each(['', ' ', 'not-json', '```json\nwrong\n```', '{broken}'])(
		'rejects %s',
		text => {
			expect(parseAnswerJson(text)).toBeUndefined()
		}
	)
	test.each([
		['null', null],
		['[]', []],
		['42', 42],
	])('preserves valid JSON %s for boundary validation', (text, expected) => {
		expect(parseAnswerJson(text)).toEqual(expected)
	})
})
