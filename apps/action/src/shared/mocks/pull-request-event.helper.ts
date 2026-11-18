export const BASE_SHA = 'a'.repeat(40)
export const HEAD_SHA = 'b'.repeat(40)

/** A trimmed pull_request_target event retains unrelated GitHub fields. */
export function eventPayload() {
	return {
		action: 'opened',
		number: 17,
		repository: { full_name: 'example/project', private: false },
		sender: { login: 'contributor' },
		pull_request: {
			number: 17,
			title: 'Update item storage',
			body: 'Keep item writes consistent.',
			draft: false,
			user: { login: 'contributor', id: 42 },
			labels: [{ name: 'storage', color: 'abcdef' }],
			base: {
				sha: BASE_SHA,
				ref: 'main',
				repo: { full_name: 'example/project', private: false },
			},
			head: {
				sha: HEAD_SHA,
				ref: 'update-storage',
				repo: { full_name: 'example/project' },
			},
			state: 'open',
			merged: false,
		},
	} as const
}
