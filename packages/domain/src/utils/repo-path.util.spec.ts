import { normalizeRepoPath } from './repo-path.util'

describe('normalizeRepoPath', () => {
	test('rejects drive paths exposed by normalization and preserves relative paths and root', () => {
		expect(normalizeRepoPath('./C:/outside.md')).toBeUndefined()
		expect(normalizeRepoPath('a/../C:/outside.md')).toBeUndefined()
		expect(normalizeRepoPath('./a/../b')).toBe('b')
		expect(normalizeRepoPath('')).toBe('.')
		expect(normalizeRepoPath('.')).toBe('.')
	})
	test.each([
		'/a',
		'../x',
		'a/../../x',
		'a\\b',
		'a\0b',
		'C:/x',
		'c:x',
		'\\server\\x',
	])('refuses unsafe path %p', path => {
		expect(normalizeRepoPath(path)).toBeUndefined()
	})
	test.each([
		['./a/../b', 'b'],
		['./src/auth.ts', 'src/auth.ts'],
		['a//b/', 'a/b'],
		['', '.'],
		['.', '.'],
		['a/..', '.'],
	])('normalizes %p to %s', (path, expected) => {
		expect(normalizeRepoPath(path)).toBe(expected)
	})
})
