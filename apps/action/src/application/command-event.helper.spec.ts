import { getCommandMismatch, toCommandEvent } from './command-event.helper'

const PULL_REQUEST = {
	number: 99,
	state: 'open',
	title: 'Change storage',
	body: 'Description',
	draft: true,
	labels: [{ name: 'storage' }, { name: 'review' }],
	user: { login: 'author-a' },
	base: {
		sha: 'api-base',
		ref: 'develop',
		repo: { full_name: 'example/project' },
	},
	head: { sha: 'api-head', repo: { full_name: 'example/fork' } },
} as const satisfies Parameters<typeof toCommandEvent>[0]
const SETTINGS = {
	pullNumber: 17,
	base: 'a'.repeat(40),
	head: 'b'.repeat(64),
	depth: 'deep',
	agent: 'storage',
} as const satisfies Parameters<typeof toCommandEvent>[1]

describe('toCommandEvent', () => {
	test('uses the authorized commits and number with manual metadata and no synthetic label', () => {
		expect(toCommandEvent(PULL_REQUEST, SETTINGS)).toEqual({
			number: SETTINGS.pullNumber,
			baseSha: SETTINGS.base,
			headSha: SETTINGS.head,
			pr: {
				title: PULL_REQUEST.title,
				body: PULL_REQUEST.body,
				author: 'author-a',
				target: 'develop',
				labels: ['storage', 'review'],
				draft: true,
				fork: true,
				trigger: 'manual',
				depth: 'deep',
			},
		})
	})
	test('omits null author and body, missing draft and an unrequested depth', () => {
		const { draft: _draft, ...pr } = PULL_REQUEST
		expect(
			toCommandEvent(
				{ ...pr, body: null, user: null, head: { ...pr.head, repo: null } },
				{ ...SETTINGS, depth: undefined, agent: undefined }
			)
		).toEqual({
			number: SETTINGS.pullNumber,
			baseSha: SETTINGS.base,
			headSha: SETTINGS.head,
			pr: {
				title: PULL_REQUEST.title,
				target: 'develop',
				labels: ['storage', 'review'],
				draft: false,
				fork: true,
				trigger: 'manual',
			},
		})
	})
	test('retains an empty body and a non-draft pull request', () => {
		expect(
			toCommandEvent({ ...PULL_REQUEST, body: '', draft: false }, SETTINGS).pr
		).toMatchObject({ body: '', draft: false })
	})
})

describe('getCommandMismatch', () => {
	const matching = {
		...PULL_REQUEST,
		head: { sha: SETTINGS.head, repo: PULL_REQUEST.base.repo },
	} as const

	test('accepts an open pull request on the authorized head in the same repository', () => {
		expect(getCommandMismatch(matching, SETTINGS)).toBeUndefined()
	})
	test('rejects a closed pull request before checking its head and fork', () => {
		expect(
			getCommandMismatch({ ...PULL_REQUEST, state: 'closed' }, SETTINGS)
		).toBe('the pull request closed after the command')
	})
	test('rejects a new head before checking the fork', () => {
		expect(getCommandMismatch(PULL_REQUEST, SETTINGS)).toBe(
			'the pull request has a new head since the command; comment again to review it'
		)
	})
	test.each([null, { full_name: 'example/fork' }])(
		'rejects a matching head from fork %j',
		repo => {
			expect(
				getCommandMismatch(
					{ ...matching, head: { ...matching.head, repo } },
					SETTINGS
				)
			).toBe('the pull request comes from a fork')
		}
	)
})
