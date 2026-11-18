import { unifiedDiff } from '../../../shared/mocks/domain-test.helper'
import {
	MAX_ROUTER_DIFF_CHARS,
	toRouterUserMessage,
} from './router-prompt.helper'

describe('toRouterUserMessage', () => {
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
