import { GitHubApiError } from '../../../platform/github.errors'
import { report, reviewThread } from '../../../shared/mocks/publish-test.helper'
import {
	getVerdict,
	isBotComment,
	isRefused,
	toBotThread,
} from './bot-thread.helper'
import { BOT_LOGIN } from './publish.constants'

describe('bot thread ownership', () => {
	test.each([
		{ author: null, editor: null, owned: false },
		{
			author: { __typename: 'User', login: BOT_LOGIN },
			editor: null,
			owned: false,
		},
		{
			author: { __typename: 'Bot', login: 'other-bot' },
			editor: null,
			owned: false,
		},
		{
			author: { __typename: 'Bot', login: BOT_LOGIN },
			editor: null,
			owned: true,
		},
		{
			author: { __typename: 'Bot', login: BOT_LOGIN },
			editor: { __typename: 'Bot', login: BOT_LOGIN },
			owned: true,
		},
		{
			author: { __typename: 'Bot', login: BOT_LOGIN },
			editor: { __typename: 'User', login: 'contributor' },
			owned: false,
		},
		{
			author: { __typename: 'Bot', login: BOT_LOGIN },
			editor: { __typename: 'User', login: BOT_LOGIN },
			owned: false,
		},
		{
			author: { __typename: 'Bot', login: BOT_LOGIN },
			editor: { __typename: 'Bot', login: 'other-bot' },
			owned: false,
		},
	])('requires bot identity and trusted editor $author $editor', row => {
		expect(isBotComment(row)).toBe(row.owned)
		const thread = reviewThread()
		expect(
			toBotThread({
				...thread,
				comments: {
					...thread.comments,
					nodes: thread.comments.nodes.map(comment => ({
						...comment,
						author: row.author,
						editor: row.editor,
					})),
				},
			}) !== undefined
		).toBe(row.owned)
	})
	test('ignores empty and unmarked threads', () => {
		expect(
			toBotThread(
				reviewThread(undefined, { comments: { totalCount: 0, nodes: [] } })
			)
		).toBeUndefined()
		const thread = reviewThread()
		expect(
			toBotThread({
				...thread,
				comments: {
					...thread.comments,
					nodes: thread.comments.nodes.map(comment => ({
						...comment,
						body: 'No marker',
					})),
				},
			})
		).toBeUndefined()
	})
	test('file subjects use marker line and count replies', () => {
		const thread = reviewThread(undefined, {
			subjectType: 'FILE',
			line: 999,
			originalLine: 888,
		})
		expect(
			toBotThread({
				...thread,
				comments: { ...thread.comments, totalCount: 4 },
			})
		).toMatchObject({
			onFile: true,
			line: undefined,
			originalLine: 10,
			replies: 3,
		})
	})
	test('line subjects fall back to marker original line when outdated', () => {
		expect(
			toBotThread(reviewThread(undefined, { line: null, originalLine: null }))
		).toMatchObject({ onFile: false, line: undefined, originalLine: 10 })
	})
})

describe('publish verdict', () => {
	test.each([
		{
			endpointError: undefined,
			incomplete: undefined,
			open: 0,
			verdict: 'ready',
		},
		{
			endpointError: 'offline',
			incomplete: undefined,
			open: 0,
			verdict: 'incomplete',
		},
		{
			endpointError: undefined,
			incomplete: { reason: 'budget', unfinished: [] },
			open: 0,
			verdict: 'incomplete',
		},
		{
			endpointError: 'offline',
			incomplete: { reason: 'budget', unfinished: [] },
			open: 1,
			verdict: 'needs fixes',
		},
	])('returns $verdict with $open open bugs', row => {
		expect(
			getVerdict(
				{
					...report(),
					endpointError: row.endpointError,
					incomplete: row.incomplete,
				},
				row.open
			)
		).toBe(row.verdict)
	})
	for (const status of ['ok', 'failed', 'incomplete'] as const)
		for (const openBugs of [0, 1])
			test(`finder ${status} with ${openBugs} open bugs`, () => {
				const finder = {
					name: 'specialist',
					title: 'Specialist',
					kind: 'bug',
					model: 'model-a',
					effort: 'high',
					status,
					toolCalls: 0,
					findings: 0,
					malformed: 0,
					wallMillis: 0,
				} as const
				expect(
					getVerdict(
						{
							...report(),
							agents: [{ ...finder, name: 'reviewer', status: 'ok' }, finder],
						},
						openBugs
					)
				).toBe(
					openBugs > 0
						? 'needs fixes'
						: status === 'ok'
							? 'ready'
							: 'incomplete'
				)
			})

	test.each([undefined, 400, 401, 403, 404, 422, 500, 503])(
		'only 422 is a place refusal: %s',
		status => {
			expect(
				isRefused(
					new GitHubApiError({
						operation: 'write',
						reason: 'failure',
						...(status === undefined ? {} : { status }),
					})
				)
			).toBe(status === 422)
		}
	)
})
