import { toWordCut } from './word-cut.util'

describe('toWordCut', () => {
	test('keeps text that fits', () => {
		expect(toWordCut('short text', 10)).toBe('short text')
	})
	test('cuts at the last word boundary within the limit and adds an ellipsis', () => {
		expect(toWordCut('one two three four', 12)).toBe('one two…')
	})
	test('drops a comma, semicolon or colon before the ellipsis', () => {
		expect(toWordCut('alpha beta, gamma delta', 14)).toBe('alpha beta…')
	})
	test('cuts a long token mid-word rather than leave a stub', () => {
		expect(toWordCut(`a ${'x'.repeat(30)}`, 10)).toBe(`a ${'x'.repeat(7)}…`)
	})
	test('never splits a surrogate pair', () => {
		expect(toWordCut(`${'x'.repeat(8)}😀😀`, 10)).toBe(`${'x'.repeat(8)}…`)
	})
	test.each([1, 5, 20, 99])('never exceeds the limit %i', max => {
		expect(
			toWordCut('word '.repeat(40).trim(), max).length
		).toBeLessThanOrEqual(max)
	})
})
