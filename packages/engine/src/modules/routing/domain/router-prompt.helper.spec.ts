import { file, unifiedDiff } from '../../../shared/mocks/domain-test.helper'
import {
	MAX_ROUTER_DIFF_CHARS,
	toRouterUserMessage,
} from './router-prompt.helper'

describe('toRouterUserMessage', () => {
	test('sorts the file list by path independently of input order without mutating it', () => {
		const files = [
			file('src/z.ts', {
				status: 'renamed',
				oldPath: 'src/old.ts',
				additions: 3,
				deletions: 2,
			}),
			file('src/a.ts', { additions: 1, deletions: 0 }),
			file('README.md', { status: 'added', additions: 5, deletions: 0 }),
		]
		const diff = unifiedDiff('src/z.ts') + unifiedDiff('src/a.ts')
		const message = toRouterUserMessage(files, [], diff)
		expect(message).toContain(
			'Changed files:\n```text\nadded README.md +5 -0\nmodified src/a.ts +1 -0\nrenamed src/z.ts (from src/old.ts) +3 -2\n```'
		)
		expect(toRouterUserMessage(files.toReversed(), [], diff)).toBe(message)
		expect(files.map(entry => entry.path)).toEqual([
			'src/z.ts',
			'src/a.ts',
			'README.md',
		])
	})

	test('includes diff excerpts when 41 files each exceed the router budget', () => {
		const blocks = Array.from({ length: 41 }, (_, index) =>
			unifiedDiff(`file-${String(index).padStart(2, '0')}.ts`, 4000)
		)
		expect(
			blocks.every(block => block.length > MAX_ROUTER_DIFF_CHARS)
		).toBeTruthy()
		const message = toRouterUserMessage([], [], blocks.join(''))
		const diff = message.split('Diff:\n```text\n')[1]?.split('\n```')[0] ?? ''
		expect(diff).not.toBe('(none)')
		expect(diff).toContain('diff --git a/file-00.ts b/file-00.ts')
		expect(diff).toMatch(/\[cut: \d+ more characters of this file's diff\]/u)
		expect(diff.length).toBeLessThanOrEqual(MAX_ROUTER_DIFF_CHARS)
	})
})
