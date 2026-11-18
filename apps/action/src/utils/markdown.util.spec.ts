import { escapeMarkdown, toCodeSpan } from './markdown.util'

describe('escapeMarkdown', () => {
	test('escapes image, HTML and table syntax and flattens line breaks', () => {
		expect(
			escapeMarkdown(
				'![x](https://evil.example/a.png) <img src=x> | col\r\n next'
			)
		).toBe(
			'\\!\\[x\\]\\(https://evil.example/a.png\\) \\<img src=x\\> \\| col next'
		)
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

describe('toCodeSpan', () => {
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
