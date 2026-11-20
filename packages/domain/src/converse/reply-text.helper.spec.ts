import { toCutLine, toOneLine, toPlainText } from './reply-text.helper'

describe('reply text helpers', () => {
	test.each([
		['  one\n two\r\n\tthree  ', 'one two three'],
		[' \t\n ', ''],
		['unchanged', 'unchanged'],
	] as const)('collapses %j to one line', (text, expected) => {
		expect(toOneLine(text)).toBe(expected)
	})
	test.each([
		['  one\n two ', 7, 'one two'],
		['abcdefgh', 7, 'abcdef…'],
		['abc   def', 5, 'abc…'],
		['abc', 1, '…'],
		['', 3, ''],
	] as const)(
		'cuts %j at %s after normalizing whitespace',
		(text, max, expected) => {
			expect(toCutLine(text, max)).toBe(expected)
		}
	)
	test('removes every markup delimiter and mention character while preserving other text', () => {
		expect(toPlainText('<!-- a --> `<b>` @name @@next')).toBe(
			'!-- a -- b name next'
		)
	})
})
