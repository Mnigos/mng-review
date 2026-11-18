import { escapeMarkdown, toCodeSpan, toLogText } from './markdown.util'

describe('escapeMarkdown', () => {
	test('escapes image, HTML and table syntax and flattens line breaks', () => {
		expect(
			escapeMarkdown(
				'![x](https://evil.example/a.png) <img src=x> | col\r\n next'
			)
		).toBe(
			'\\!\\[x\\]\\(`https://evil.example/a.png)` \\<img src=x\\> \\| col next'
		)
	})
	test.each([
		[
			'HTTPS URL',
			'https://example.com/a_b?q=x&next=1',
			'`https://example.com/a_b?q=x&next=1`',
		],
		['FTP URL', 'ftp://example.com/file.txt', '`ftp://example.com/file.txt`'],
		['www host', 'www.example.com/path', '`www.example.com/path`'],
		[
			'URL glued to an underscore',
			'_https://evil.example',
			'\\_`https://evil.example`',
		],
		[
			'URL glued to a digit',
			'1https://evil.example',
			'1`https://evil.example`',
		],
		['www host glued to text', 'x_www.evil.example', 'x\\_`www.evil.example`'],
		['email address', 'review+test@example.com', '`review+test@example.com`'],
		[
			'table separator',
			'| https://example.com/a| next |',
			'\\| `https://example.com/a`\\| next \\|',
		],
		[
			'embedded backticks',
			'https://example.com/a`b``c',
			'`https://example.com/a`\\`b\\`\\`c',
		],
		[
			'several autolinks',
			'https://example.com ftp://example.com www.example.com test@example.com',
			'`https://example.com` `ftp://example.com` `www.example.com` `test@example.com`',
		],
		[
			'surrounding syntax',
			'*before* https://example.com/a\t_after_ [tail]\r\n# next',
			'\\*before\\* `https://example.com/a` \\_after\\_ \\[tail\\] \\# next',
		],
	])(
		'encloses %s in code while escaping other text',
		(_name, input, expected) => {
			expect(escapeMarkdown(input)).toBe(expected)
		}
	)
	test.each([
		['a lone carriage return', 'first\rlast'],
		['consecutive carriage returns', 'first\r\rlast'],
		['NUL', 'first\u0000last'],
	])('flattens %s to one space', (_name, input) => {
		expect(escapeMarkdown(input)).toBe('first last')
	})
	test('escapes every Markdown syntax character including backslashes and entities', () => {
		for (const character of [
			'\\',
			'`',
			'*',
			'_',
			'[',
			']',
			'(',
			')',
			'!',
			'<',
			'>',
			'|',
			'#',
			'~',
			'&',
		])
			expect(escapeMarkdown(character)).toBe(`\\${character}`)
	})
	test('retains plain text and empty strings', () => {
		expect(escapeMarkdown('plain text: 42')).toBe('plain text: 42')
		expect(escapeMarkdown('')).toBe('')
	})
})

describe('toLogText', () => {
	test.each([
		['CR/LF', 'first\r\nsecond\rthird\nfourth', 'first second third fourth'],
		['C0 controls', 'a\u0000b\u0007c\td\u000Be\u000Cf', 'a b c d e f'],
		['DEL and C1 controls', 'a\u007Fb\u0085c\u009Bd', 'a b c d'],
		['ANSI escape', '\u001B[31mred\u001B[0m', ' [31mred [0m'],
		['right-to-left override', 'first\u202Elast', 'first last'],
		['zero-width space', 'first\u200Blast', 'first last'],
		['line separator', 'first\u2028last', 'first last'],
		['paragraph separator', 'first\u2029last', 'first last'],
		[
			'colon markers anywhere',
			'::start middle::end::',
			': :start middle: :end: :',
		],
		[
			'legacy markers anywhere',
			'##[error] middle ##[warning] end##[',
			'## [error] middle ## [warning] end## [',
		],
		[
			'mixed workflow commands',
			'\n::add-mask::x\r\n::error::failure\n::stop-commands::t\n##[error]',
			' : :add-mask: :x : :error: :failure : :stop-commands: :t ## [error]',
		],
		[
			'ordinary text',
			'plain : text # [value] https://example.com',
			'plain : text # [value] https://example.com',
		],
		['empty text', '', ''],
	])('neutralizes %s', (_name, input, expected) => {
		expect(toLogText(input)).toBe(expected)
	})
})

describe('toCodeSpan', () => {
	test.each([
		['a lone carriage return', 'first\rlast'],
		['consecutive carriage returns', 'first\r\rlast'],
		['NUL', 'first\u0000last'],
	])('flattens %s to one space inside code', (_name, input) => {
		expect(toCodeSpan(input)).toBe('`first last`')
	})
	test('uses a longer fence than embedded backticks', () => {
		expect(toCodeSpan('a`b``c')).toBe('```a`b``c```')
	})
	test('pads content beginning or ending in a backtick', () => {
		expect(toCodeSpan('`path`')).toBe('`` `path` ``')
		expect(toCodeSpan('path`')).toBe('`` path` ``')
	})
	test('flattens lines and encloses text in code', () => {
		expect(toCodeSpan('src/items.ts:2\r\n next')).toBe('`src/items.ts:2 next`')
	})
})
