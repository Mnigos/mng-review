import { getCodeBlocks } from '../shared/mocks/hostile-text.helper'
import {
	escapeMarkdown,
	escapeCommentOpen,
	toCodeBlock,
	toShort,
	toCodeSpan,
	toLogText,
} from './markdown.util'

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
	test.each(['@user', '@org/team', '#12', 'owner/repo#12', 'GH-12'])(
		'wraps %s even immediately after a backtick',
		reference => {
			expect(escapeMarkdown(`\`${reference}`)).toBe(`\\\`\`${reference}\``)
		}
	)
	test.each([
		'abcdef1',
		'ABCDEF1',
		'1234567',
		'abcdef1234567890abcdef1234567890abcdef12',
		'owner/repo@abcdef1',
		'abcdef1...1234567',
		'abcdef1..1234567',
	])('wraps commit reference %s in code', reference => {
		expect(escapeMarkdown(reference)).toBe(`\`${reference}\``)
	})
	test.each([
		['bidirectional override', 'first\u202Elast', 'firstlast'],
		['zero-width mark inside a mention', '@us\u200Ber', '`@user`'],
		['format marks around an issue', '\u2066#12\u2069', '`#12`'],
		['minus list marker', '- item', '\\- item'],
		['plus list marker', '+ item', '\\+ item'],
		['heading underline marker', '= title', '\\= title'],
		['indented list marker', '  - item', ' \\- item'],
		['numbered list with dot', '12. item', '12\\. item'],
		['numbered list with parenthesis', '3) item', '3\\) item'],
		[
			'ordinary words and short numbers',
			'hello world 1 123456 abcdef',
			'hello world 1 123456 abcdef',
		],
		['hex longer than a commit', 'a'.repeat(41), 'a'.repeat(41)],
		['hex inside a word', 'zabcdef1z', 'zabcdef1z'],
	])('handles %s', (_name, input, expected) => {
		expect(escapeMarkdown(input)).toBe(expected)
	})

	test.each([
		[
			'HTTPS URL',
			'https://example.com/a_b?q=x&next=1',
			'`https://example.com/a_b?q=x&next=1`',
		],
		['FTP URL', 'ftp://example.com/file.txt', '`ftp://example.com/file.txt`'],
		[
			'Git SSH URL',
			'git+ssh://example.com/repository.git',
			'`git+ssh://example.com/repository.git`',
		],
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
		['email address with dots', 'x.y@example.com', '`x.y@example.com`'],
		['email address with a plus', 'x+z@example.com', '`x+z@example.com`'],
		[
			'email address with hyphens',
			'x-y@example-domain.com',
			'`x-y@example-domain.com`',
		],
		[
			'email address with dots and a plus',
			'x.y+z@example.com',
			'`x.y+z@example.com`',
		],
		[
			'email address glued after punctuation',
			'contact:(x.y+z-w@example.com)',
			'contact:\\(`x.y+z-w@example.com)`',
		],
		[
			'table separator',
			'| https://example.com/a| next |',
			'\\| `https://example.com/a`\\| next \\|',
		],
		[
			'embedded backticks',
			'https://example.com/a`b``c',
			'```https://example.com/a`b``c```',
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
	test('only escapes a long run of word characters without an at sign', () => {
		const word = 'abc123_'.repeat(2000)
		expect(escapeMarkdown(`*${word}*`)).toBe(
			`\\*${'abc123\\_'.repeat(2000)}\\*`
		)
	})
	test('encloses only the final 32 letters of a 40-letter scheme in code', () => {
		expect(escapeMarkdown(`${'a'.repeat(40)}://example.com`)).toBe(
			`${'a'.repeat(8)}\`${'a'.repeat(32)}://example.com\``
		)
	})
	test('only escapes text around a very long word of letters', () => {
		const word = 'a'.repeat(16_000)
		expect(escapeMarkdown(`*${word}*`)).toBe(`\\*${word}\\*`)
	})
	test('retains plain text and empty strings', () => {
		expect(escapeMarkdown('plain text: 42')).toBe('plain text: 42')
		expect(escapeMarkdown('')).toBe('')
	})
})

describe('toLogText', () => {
	test.each([
		['three colons', ':::', ': : :'],
		['four colons', '::::', ': : : :'],
		['five colons', ':::::', ': : : : :'],
		['three colons after NUL', '\u0000:::', ' : : :'],
		['four colons after NUL', '\u0000::::', ' : : : :'],
		['five colons after NUL', '\u0000:::::', ' : : : : :'],
	])('breaks every pair in %s', (_name, input, expected) => {
		const text = toLogText(input)
		expect(text).toBe(expected)
		expect(text).not.toContain('::')
	})
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

describe('escapeMarkdown next to a code span', () => {
	test.each([
		['deadbeef@victim', '`deadbeef@victim`'],
		['@a@victim', '`@a@victim`'],
		['a@b.co@victim', '`a@b.co@victim`'],
		['#1@victim', '`#1@victim`'],
		['deadbeef#12', '`deadbeef#12`'],
	])('keeps the whole token %s in one code span', (text, expected) => {
		expect(escapeMarkdown(text)).toBe(expected)
	})
	test('stops the code span at a table cell border', () => {
		expect(escapeMarkdown('x | deadbeef | y')).toBe('x \\| `deadbeef` \\| y')
	})
	test('wraps advisory identifiers', () => {
		expect(escapeMarkdown('see CVE-2024-1234 and GHSA-abcd-efgh-ijkl')).toBe(
			'see `CVE-2024-1234` and `GHSA-abcd-efgh-ijkl`'
		)
	})
})

describe('toCodeSpan', () => {
	test('drops bidirectional overrides so a path cannot be shown reversed', () => {
		expect(toCodeSpan('src/a\u202Ests.ts:12')).toBe('`src/asts.ts:12`')
	})
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

describe('toCodeBlock', () => {
	test.each(['text', 'suggestion'])(
		'uses a fence longer than all embedded runs for %s',
		info => {
			const input =
				'@user #12 deadbeef </details> -->\n```\n``````\n<img src=x>'
			const body = toCodeBlock(input, info)
			expect(body).toBe(`\`\`\`\`\`\`\`${info}\n${input}\n\`\`\`\`\`\`\``)
			expect(getCodeBlocks(body)).toEqual([
				{ fence: '`'.repeat(7), info, body: input },
			])
		}
	)
	test('normalizes CR, keeps tabs and LF, and removes hidden characters before choosing the fence', () => {
		expect(
			toCodeBlock(
				'a\r\nb\rc\t\n\u0000\u007F\u0085\u202E\u200B\u2028\u2029`\u200B``',
				'text'
			)
		).toBe('````text\na\nb\nc\t\n```\n````')
	})
	test.each(['', '\u202E\u0000'])(
		'empty or hidden-only replacement %j has no content line',
		input => {
			expect(toCodeBlock(input, 'suggestion')).toBe('```suggestion\n```')
		}
	)
})

describe('toShort', () => {
	test.each([
		['', 3, ''],
		['abc', 3, 'abc'],
		['abcd', 3, 'abc…'],
		['a', 0, '…'],
	] as const)('cuts %j at %i only when needed', (text, max, expected) => {
		expect(toShort(text, max)).toBe(expected)
	})
})

describe('escapeCommentOpen', () => {
	test('breaks every opener while retaining the model text', () => {
		const escaped = escapeCommentOpen(
			'before <!-- marker --> after <!-- unclosed'
		)
		expect(escaped).not.toContain('<!--')
		expect(escaped.replaceAll('\u2060', '')).toBe(
			'before <!-- marker --> after <!-- unclosed'
		)
	})
})
