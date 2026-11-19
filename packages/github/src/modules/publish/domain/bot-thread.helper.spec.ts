import type { ThreadComment } from '../../../platform/github-api.schema'
import { GitHubApiError } from '../../../platform/github.errors'
import {
	report,
	reviewThread,
	threadReply,
	botClosedReviewThread,
	RULES,
} from '../../../shared/mocks/publish-test.helper'
import {
	getVerdict,
	isBotComment,
	isRefused,
	toBotThread,
} from './bot-thread.helper'
import { countOpenBugs, planPublish } from './publish-plan.helper'
import { BOT_LOGIN } from './publish.constants'
import { getRecheckCandidates } from './thread-recheck.helper'

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

interface ReplyCase extends Partial<ThreadComment> {
	readonly label: string
}

describe('bot closing replies', () => {
	test.each([false, true])(
		'GitHub resolved=%s takes precedence over bot closure',
		isResolved => {
			expect(toBotThread(botClosedReviewThread({ isResolved }))).toMatchObject({
				resolved: true,
				closedByBot: !isResolved,
				replies: 1,
			})
		}
	)
	test.each([
		{ label: 'missing latest', latest: undefined },
		{ label: 'empty latest', latest: { nodes: [] } },
		{
			label: 'only the root comment',
			comments: { ...reviewThread().comments, totalCount: 1 },
		},
	])('$label leaves a GitHub-open thread open', overrides => {
		expect(toBotThread(botClosedReviewThread(overrides))).toMatchObject({
			resolved: false,
			closedByBot: false,
		})
	})

	test.each([
		{
			label: 'human reply after the bot closure',
			author: { __typename: 'User', login: 'contributor' },
		},
		{
			label: 'human using the bot login',
			author: { __typename: 'User', login: BOT_LOGIN },
		},
		{ label: 'another bot', author: { __typename: 'Bot', login: 'other-bot' } },
		{ label: 'deleted author', author: null },
		{ label: 'unmarked bot reply', body: 'The finding no longer holds.' },
		{
			label: 'invalid reply action',
			body: '<!-- mng-review:reply {"v":1,"action":"ignored","commit":"head"} -->',
		},
		{
			label: 'human edited bot reply',
			editor: { __typename: 'User', login: 'contributor' },
		},
		{
			label: 'human editor using bot login',
			editor: { __typename: 'User', login: BOT_LOGIN },
		},
		{
			label: 'another bot edited reply',
			editor: { __typename: 'Bot', login: 'other-bot' },
		},
	] satisfies ReplyCase[])('$label does not close a thread', overrides => {
		expect(
			toBotThread(
				botClosedReviewThread({ latest: { nodes: [threadReply(overrides)] } })
			)
		).toMatchObject({ resolved: false, closedByBot: false })
	})

	test('a reply edited by the bot itself still closes its thread', () => {
		expect(
			toBotThread(
				botClosedReviewThread({
					latest: {
						nodes: [
							threadReply({ editor: { __typename: 'Bot', login: BOT_LOGIN } }),
						],
					},
				})
			)
		).toMatchObject({ resolved: true, closedByBot: true })
	})

	test('a bot-closed bug contributes no open bugs, permits a ready verdict and is not a recheck candidate', () => {
		const thread = toBotThread(botClosedReviewThread())
		expect(thread).toBeDefined()
		if (!thread) return
		const review = { ...report(), bugs: [] }
		const plan = planPublish(
			{ outcome: review, config: RULES.config, agents: new Map() },
			{ threads: [thread], lines: new Map(), changedPlaces: new Set() }
		)
		expect(countOpenBugs(plan, [thread])).toBe(0)
		expect(getVerdict(review, countOpenBugs(plan, [thread]))).toBe('ready')
		expect(getRecheckCandidates([thread], [], 'next-head')).toEqual([])
	})
})
