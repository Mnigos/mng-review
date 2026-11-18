import { matchesGlob, matchesAnyGlob } from './glob.util'

describe('globs', () => {
	test.each([
		['dir', 'dir/**', true],
		['dir/a.ts', 'dir/**', true],
		['dir/sub/a.ts', 'dir/**', true],
		['directory/a.ts', 'dir/**', false],
		['x.ts', '*.ts', true],
		['src/x.ts', '*.ts', true],
		['packages/auth/src/x.ts', 'x.ts', true],
		['src/x.js', 'x.ts', false],
		['x.ts', '**/x.ts', true],
		['src/x.ts', '**/x.ts', true],
		['a/b/x.ts', '**/x.ts', true],
		['a/b/y.ts', '**/x.ts', false],
	] as const)('matchesGlob(%s, %s) = %s', (path, pattern, expected) => {
		expect(matchesGlob(path, pattern)).toBe(expected)
	})
	test.each([
		['src/code.ts', '!**/*.spec.ts', true],
		['src/code.spec.ts', '!**/*.spec.ts', false],
		['src/x.ts', '!x.ts', false],
		['src/y.ts', '!x.ts', true],
	] as const)(
		'negates a leading ! for %s and %s',
		(path, pattern, expected) => {
			expect(matchesGlob(path, pattern)).toBe(expected)
		}
	)

	test('matches any listed glob and handles empty lists', () => {
		expect(
			matchesAnyGlob('src/billing/x.ts', ['docs/**', 'src/billing/**'])
		).toBe(true)
		expect(matchesAnyGlob('x.ts', [])).toBe(false)
	})
})

test.each(['src/.hidden', 'src/.config/settings.ts'])(
	'src/** covers dot paths %s',
	path => {
		expect(matchesGlob(path, 'src/**')).toBeTruthy()
	}
)
