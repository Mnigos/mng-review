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
	test('replaces every markup delimiter and mention character with a space while preserving other text', () => {
		expect(toPlainText('<!-- a --> `<b>` @name @@next')).toBe(
			'  -- a --    b    name   next'
		)
	})
})

describe('toPlainText render syntax', () => {
	test.each([
		['[x](https://e.com)', ' x (https: //e.com)'],
		['![a](b.png)', '  a (b.png)'],
		['https://e.com/x', 'https: //e.com/x'],
		['www.e.com', 'www e.com'],
		['WWW.E.COM', 'WWW E.COM'],
		['GH-12', 'GH 12'],
		['gh-12', 'gh 12'],
		['GHSA-abcd-1234', 'GHSA abcd-1234'],
		['ghsa-abcd-1234', 'ghsa abcd-1234'],
		['123abcd', '123abc d'],
		['ABCDEF1', 'ABCDEF 1'],
		[
			'0123456789abcdef0123456789abcdef01234567',
			'012345 6789ab cdef01 234567 89abcd ef0123 4567',
		],
		['deadbeef', 'deadbe ef'],
		['123abcd deadbeef', '123abc d deadbe ef'],
		[
			'0123456789abcdef0123456789abcdef012345678',
			'012345 6789ab cdef01 234567 89abcd ef0123 45678',
		],
		['deadbeef_note', 'deadbe ef note'],
		['@user', ' user'],
		['`code`', ' code '],
		['<img src=x>', ' img src x '],
		[
			'src/[x]![a]@user`code`<img src=x>/www.e.com.ts',
			'src/ x   a  user code  img src x /www e.com.ts',
		],
	] as const)('removes renderable syntax from %j', (text, expected) => {
		const plain = toPlainText(text)
		expect(plain).toBe(expected)
		expect(plain).not.toMatch(/[[\]!@`<>]|:\/\/|www\./iu)
		expect(plain).toMatch(/^[\p{L}\p{N} .,;:'"/()-]*$/u)
	})
	test('preserves letters, digits and the supported punctuation', () => {
		const text = 'Żółć 日本語 0123 .,;:\'"/-()'
		expect(toPlainText(text)).toBe(text)
	})
	test.each(['abc123', 'abcdefg', 'src/auth.ts line 12', 'xdeadbeef'])(
		'preserves %j without a whole-word GitHub reference',
		text => {
			expect(toPlainText(text)).toBe(text)
		}
	)
})
