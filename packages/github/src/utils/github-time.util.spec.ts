import { toGitHubTime } from './github-time.util'

describe('toGitHubTime', () => {
	test('writes whole seconds as GitHub does, dropping the fraction', () => {
		expect(toGitHubTime(Date.UTC(2026, 0, 1, 12, 30, 0, 999))).toBe(
			'2026-01-01T12:30:00Z'
		)
	})
})
