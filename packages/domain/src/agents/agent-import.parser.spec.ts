import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { ConfigError } from '../config/config.errors'
import { extractSection, parseImportLine } from './agent-import.parser'

const MARKDOWN =
	'# Guide\nIntro\n## Rules\nOwn the row.\n### Nested\nKeep this.\n## Other\nDo not import.'

layer(Layer.empty)('parseImportLine', test => {
	for (const [line, expected] of [
		['@/docs/auth.md', { path: 'docs/auth.md' }],
		[
			' \t@/./docs/../docs/auth.md# Rules \t',
			{ path: 'docs/auth.md', heading: 'Rules' },
		],
		['@/docs/auth.md#C#', { path: 'docs/auth.md', heading: 'C#' }],
	] as const)
		test.effect(`parses standalone import ${line}`, () =>
			Effect.gen(function* () {
				expect(yield* parseImportLine(line, 'auth.md')).toEqual(expected)
			})
		)

	for (const line of [
		'See @/docs/auth.md for rules.',
		'prefix @/docs/auth.md',
		'Use `@/docs/auth.md#Rules`.',
		'',
		'ordinary instructions',
	])
		test.effect(`ignores inline or non-import text ${line}`, () =>
			Effect.gen(function* () {
				expect(yield* parseImportLine(line, 'auth.md')).toBeUndefined()
			})
		)

	for (const line of [
		'@/../x',
		'@/a/../../x',
		'@//etc/passwd',
		'@/C:/x',
		'@/a\\b',
		'@/bad\0path',
		'@/.',
		'@/a/..',
	])
		test.effect(
			`rejects import outside the repository ${JSON.stringify(line)}`,
			() =>
				Effect.gen(function* () {
					const error = yield* Effect.flip(parseImportLine(line, 'auth.md'))
					expect(error).toBeInstanceOf(ConfigError)
					expect(error.source).toBe('auth.md')
					expect(error.reason).toContain('outside the repository')
				})
		)
})

describe('extractSection', () => {
	test('includes the heading and nested headings, ending before the next peer', () => {
		expect(extractSection(MARKDOWN, 'Rules')).toBe(
			'## Rules\nOwn the row.\n### Nested\nKeep this.'
		)
	})
	test('higher-level headings end the section and the last section reaches EOF', () => {
		expect(extractSection('## Rules\nText\n# End\nOther', 'Rules')).toBe(
			'## Rules\nText'
		)
		expect(extractSection(MARKDOWN, 'Other')).toBe('## Other\nDo not import.')
		expect(extractSection(MARKDOWN, 'Missing')).toBeUndefined()
	})
	test('supports CRLF and strips trailing blank lines', () => {
		expect(extractSection('## Rules\r\nText\r\n\r\n## End', 'Rules')).toBe(
			'## Rules\nText'
		)
	})
	test('keeps literal hashes and removes whitespace-separated closing hashes', () => {
		expect(extractSection('## C#\nText\n## End', 'C#')).toBe('## C#\nText')
		expect(extractSection('## Rules ##\nText\n## End', 'Rules')).toBe(
			'## Rules ##\nText'
		)
		expect(extractSection('## Rules##\nText', 'Rules')).toBeUndefined()
		expect(extractSection('## Rules##\nText', 'Rules##')).toBe(
			'## Rules##\nText'
		)
	})
	test.each(['```', '~~~~'])(
		'ignores headings inside %s code fences',
		fence => {
			const md = `${fence}md\n## Rules\nFake\n${fence}\n## Rules\nReal\n${fence}\n# Stop\n${fence}\n### Nested\nKept\n## End\nExcluded`
			expect(extractSection(md, 'Rules')).toBe(
				`## Rules\nReal\n${fence}\n# Stop\n${fence}\n### Nested\nKept`
			)
		}
	)
	test.each([
		['````', '```'],
		['~~~~', '~~~'],
		['```', '~~~'],
		['~~~', '```'],
		['```', '``` x'],
		['~~~', '~~~ x'],
		['```', '    ```'],
		['~~~', '    ~~~'],
	])('opening %s is not closed by %s', (opening, invalidClose) => {
		const section = `## Rules\n${opening}\n${invalidClose}\n# Fake\n${opening}\n### Nested\nKept`
		expect(extractSection(`${section}\n## End\nExcluded`, 'Rules')).toBe(
			section
		)
		expect(extractSection(`${section}\n## End`, 'Fake')).toBeUndefined()
	})
	test.each(['```', '~~~'])(
		'longer %s fence with up to three spaces and trailing whitespace closes',
		marker => {
			for (const indent of ['', ' ', '  ', '   ']) {
				const section = `## Rules\n${indent}${marker}md\n# Fake\n${indent}${marker}${marker[0]} \t`
				expect(extractSection(`${section}\n## End\nExcluded`, 'Rules')).toBe(
					section.trimEnd()
				)
				expect(extractSection(`${section}\n## End`, 'Fake')).toBeUndefined()
			}
		}
	)
	test('a backtick in the info string prevents opening a backtick fence', () => {
		expect(extractSection('```js```\n## Rules\nReal\n## End', 'Rules')).toBe(
			'## Rules\nReal'
		)
	})
	test.each(['    ```', '    ~~~'])(
		'four-space indentation does not open a fence %s',
		opening => {
			expect(
				extractSection(`${opening}\n## Rules\nReal\n## End`, 'Rules')
			).toBe('## Rules\nReal')
		}
	)
})

test('backticks in a backtick fence info string prevent it from opening', () => {
	expect(extractSection('```js```\n## Rules\nReal\n## End', 'Rules')).toBe(
		'## Rules\nReal'
	)
})

test('four spaces prevent an opening fence but up to three spaces allow it', () => {
	expect(extractSection('    ```\n## Rules\nReal\n## End', 'Rules')).toBe(
		'## Rules\nReal'
	)
	for (const indent of ['', ' ', '  ', '   '])
		expect(
			extractSection(
				`${indent}\`\`\`js\n## Rules\nHidden\n${indent}\`\`\``,
				'Rules'
			)
		).toBeUndefined()
})
