import { verdict } from '../shared/mocks/domain-test.helper'
import {
	isPlainCode,
	MAX_EDIT_CHARS,
	MAX_EDIT_LINES,
	toConfirmedEdit,
	type EditInput,
} from './confirmed-edit.helper'

/** A validator edit checked against a committed two-line file. */
function input(overrides: Partial<EditInput> = {}): EditInput {
	return {
		verdict: verdict({ edit: { line: '\told()', replacement: '\tnew()' } }),
		line: 2,
		commit: 'a'.repeat(40),
		headText: 'first\n\told()\t \r\nlast',
		...overrides,
	}
}

describe('toConfirmedEdit', () => {
	test('compares the head line ignoring trailing whitespace and CR, stamps the head and keeps its exact text', () => {
		expect(toConfirmedEdit(input())).toEqual({
			commit: input().commit,
			line: 2,
			original: '\told()\t \r',
			replacement: '\tnew()',
		})
	})
	test.each(['reject', 'unverified'] as const)(
		'refuses an edit on %s',
		name => {
			expect(
				toConfirmedEdit(
					input({
						verdict: verdict({
							verdict: name,
							edit: { line: '\told()', replacement: 'new()' },
						}),
					})
				)
			).toBeUndefined()
		}
	)
	test.each([undefined, null])('refuses absent edit %j', edit => {
		expect(
			toConfirmedEdit(input({ verdict: verdict({ edit }) }))
		).toBeUndefined()
	})
	test.each([0, -1, 5])('refuses out-of-range line %i', line => {
		expect(toConfirmedEdit(input({ line }))).toBeUndefined()
	})
	test('refuses a missing file', () => {
		expect(toConfirmedEdit(input({ headText: undefined }))).toBeUndefined()
	})
	test('refuses a head line longer than the edit cap, even when it matches after trimming', () => {
		const padded = `\told()${' '.repeat(MAX_EDIT_CHARS)}`
		expect(
			toConfirmedEdit(input({ headText: `first\n${padded}\nlast` }))
		).toBeUndefined()
		expect(
			toConfirmedEdit(
				input({
					headText: `first\n\told()${' '.repeat(MAX_EDIT_CHARS - 7)}\nlast`,
				})
			)?.original.length
		).toBe(MAX_EDIT_CHARS - 1)
	})
	test.each(['old()', '\tother()', '\told()\nlast'])(
		'refuses mismatched source %j',
		line => {
			expect(
				toConfirmedEdit(
					input({ verdict: verdict({ edit: { line, replacement: 'new()' } }) })
				)
			).toBeUndefined()
		}
	)
	test.each(['\told()', '\told()  ', '\told()\n'])(
		'refuses unchanged replacement %j',
		replacement => {
			expect(
				toConfirmedEdit(
					input({
						verdict: verdict({ edit: { line: '\told()', replacement } }),
					})
				)
			).toBeUndefined()
		}
	)
	test.each(['', 'new()\n', 'new()\nnext()'])(
		'keeps deletion or multiline replacement %j and removes one terminal newline',
		replacement => {
			expect(
				toConfirmedEdit(
					input({
						verdict: verdict({ edit: { line: '\told()', replacement } }),
					})
				)
			).toEqual({
				commit: input().commit,
				line: 2,
				original: '\told()\t \r',
				replacement: replacement.replace(/\n$/u, ''),
			})
		}
	)
	test.each([
		'\u0000',
		'\r',
		'\u007F',
		'\u0085',
		'\u202E',
		'\u200B',
		'\u2028',
		'\u2029',
	])('refuses hidden character %j in a replacement', hidden => {
		expect(isPlainCode(`new${hidden}()`)).toBe(false)
		expect(
			toConfirmedEdit(
				input({
					verdict: verdict({
						edit: { line: '\told()', replacement: `new${hidden}()` },
					}),
				})
			)
		).toBeUndefined()
	})
	test('plain code permits tabs, newlines and Unicode identifiers', () => {
		expect(isPlainCode('\tconst café = 1\nnext()')).toBe(true)
	})
	test.each([MAX_EDIT_CHARS, MAX_EDIT_CHARS + 1])(
		'enforces the character boundary %i',
		count => {
			const edit = toConfirmedEdit(
				input({
					verdict: verdict({
						edit: { line: '\told()', replacement: 'x'.repeat(count) },
					}),
				})
			)
			expect(edit?.replacement).toBe(
				count === MAX_EDIT_CHARS ? 'x'.repeat(count) : undefined
			)
		}
	)
	test.each([MAX_EDIT_LINES, MAX_EDIT_LINES + 1])(
		'enforces the line boundary %i',
		count => {
			const replacement = Array.from({ length: count }, () => 'x').join('\n')
			expect(
				toConfirmedEdit(
					input({
						verdict: verdict({ edit: { line: '\told()', replacement } }),
					})
				)?.replacement
			).toBe(count === MAX_EDIT_LINES ? replacement : undefined)
		}
	)
	test.each(['2| new()', '2| new()\n3| next()'])(
		'refuses numbered read_file copy %j',
		replacement => {
			expect(
				toConfirmedEdit(
					input({
						verdict: verdict({ edit: { line: '\told()', replacement } }),
					})
				)
			).toBeUndefined()
		}
	)
})
