import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { RECENT_COMMENTS } from '../../../platform/github-api.constants'
import type { ThreadComment } from '../../../platform/github-api.schema'
import { GitHubApiError } from '../../../platform/github.errors'
import {
	bug,
	APP_MODE_IDENTITIES,
	APP_IDENTITY,
	report,
	agentReport,
	reviewThread,
	threadReply,
	botClosedReviewThread,
	RULES,
} from '../../../shared/mocks/publish-test.helper'
import {
	editedOwnerReviewThread,
	rawThread,
	markedThreadReply,
	ownerReviewThread,
} from '../../../shared/mocks/thread-reply-test.helper'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import {
	getOwnerAnswered,
	getUnreadOwnerThreads,
	hasOwnerAnswer,
	getVerdict,
	isFullReview,
	isBotComment,
	isRefused,
	isUnsettled,
	toBodyDigest,
	toBotThread,
} from './bot-thread.helper'
import { countOpenBugs, planPublish } from './publish-plan.helper'
import { MARKER_VERSION } from './publish.constants'
import { getRecheckCandidates } from './thread-recheck.helper'

/** Token mode with the preset's `identity.previous`. */
const OWNED = [GITHUB_ACTIONS_IDENTITY]

describe('reply body digests', () => {
	test('hashes the whole UTF-8 body with SHA-256', () => {
		expect(toBodyDigest('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		)
		expect(toBodyDigest('')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		)
		expect(toBodyDigest('é')).not.toBe(toBodyDigest('e'))
	})
	test('uses the latest comment body rather than the root for latestDigest', () => {
		const body = 'Latest reply beyond the finding marker'
		expect(
			toBotThread(
				botClosedReviewThread({ latest: { nodes: [threadReply({ body })] } }),
				OWNED
			)
		).toMatchObject({
			latestDigest: toBodyDigest(body),
			closedAt: undefined,
		})
	})
})

describe('bot thread ownership', () => {
	test.each([
		{ author: null, editor: null, owned: false },
		{
			author: { __typename: 'User', login: GITHUB_ACTIONS_IDENTITY.login },
			editor: null,
			owned: false,
		},
		{
			author: { __typename: 'Bot', login: 'other-bot' },
			editor: null,
			owned: false,
		},
		{
			author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
			editor: null,
			owned: true,
		},
		{
			author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
			editor: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
			owned: true,
		},
		{
			author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
			editor: { __typename: 'User', login: 'contributor' },
			owned: false,
		},
		{
			author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
			editor: { __typename: 'User', login: GITHUB_ACTIONS_IDENTITY.login },
			owned: false,
		},
		{
			author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
			editor: { __typename: 'Bot', login: 'other-bot' },
			owned: false,
		},
	])('requires bot identity and trusted editor $author $editor', row => {
		expect(isBotComment(row, OWNED)).toBe(row.owned)
		const thread = reviewThread()
		expect(
			toBotThread(
				{
					...thread,
					comments: {
						...thread.comments,
						nodes: thread.comments.nodes.map(comment => ({
							...comment,
							author: row.author,
							editor: row.editor,
						})),
					},
				},
				OWNED
			) !== undefined
		).toBe(row.owned)
	})
	test('ignores empty and unmarked threads', () => {
		expect(
			toBotThread(
				reviewThread(undefined, { comments: { totalCount: 0, nodes: [] } }),
				OWNED
			)
		).toBeUndefined()
		const thread = reviewThread()
		expect(
			toBotThread(
				{
					...thread,
					comments: {
						...thread.comments,
						nodes: thread.comments.nodes.map(comment => ({
							...comment,
							body: 'No marker',
						})),
					},
				},
				OWNED
			)
		).toBeUndefined()
	})
	test('file subjects use marker line and count replies', () => {
		const thread = reviewThread(undefined, {
			subjectType: 'FILE',
			line: 999,
			originalLine: 888,
		})
		expect(
			toBotThread(
				{
					...thread,
					comments: { ...thread.comments, totalCount: 4 },
				},
				OWNED
			)
		).toMatchObject({
			onFile: true,
			line: undefined,
			originalLine: 10,
			replies: 3,
		})
	})
	test('line subjects fall back to marker original line when outdated', () => {
		expect(
			toBotThread(
				reviewThread(undefined, { line: null, originalLine: null }),
				OWNED
			)
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
	test('a SHA-256 closing marker is a closure baseline, as COMMIT_SHA allows', () => {
		const body = toMarkerComment('reply', {
			v: MARKER_VERSION,
			action: 'resolved',
			commit: 'a'.repeat(64),
			reply: 42,
		})
		expect(
			toBotThread(
				botClosedReviewThread({ latest: { nodes: [threadReply({ body })] } }),
				OWNED
			)?.closedAt
		).toBe('a'.repeat(64))
	})
	for (const action of ['resolved', 'accepted'] as const)
		test.each([
			'a'.repeat(40),
			'abcdef0123'.repeat(4),
			'head',
			'a'.repeat(39),
			'a'.repeat(41),
			'g'.repeat(40),
		])(
			`${action} records closedAt only for a full hexadecimal SHA: %s`,
			commit => {
				const body = toMarkerComment('reply', {
					v: MARKER_VERSION,
					action,
					commit,
					reply: 42,
				})
				expect(
					toBotThread(
						botClosedReviewThread({
							latest: { nodes: [threadReply({ body })] },
						}),
						OWNED
					)
				).toMatchObject({
					resolved: true,
					closedAt: /^[a-f0-9]{40}$/iu.test(commit) ? commit : undefined,
					latestDigest: toBodyDigest(body),
				})
			}
		)
	test.each(['still-found', 'disputed', 'seen', 'needs-owner'] as const)(
		'a latest %s reply has no closing baseline',
		action => {
			const body = toMarkerComment('reply', {
				v: MARKER_VERSION,
				action,
				commit: 'a'.repeat(40),
				reply: 42,
			})
			expect(
				toBotThread(
					botClosedReviewThread({ latest: { nodes: [threadReply({ body })] } }),
					OWNED
				)
			).toMatchObject({
				resolved: false,
				closedAt: undefined,
			})
		}
	)
	test.each([false, true])(
		'GitHub resolved=%s takes precedence over bot closure',
		isResolved => {
			expect(
				toBotThread(botClosedReviewThread({ isResolved }), OWNED)
			).toMatchObject({
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
		expect(toBotThread(botClosedReviewThread(overrides), OWNED)).toMatchObject({
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
			author: { __typename: 'User', login: GITHUB_ACTIONS_IDENTITY.login },
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
			editor: { __typename: 'User', login: GITHUB_ACTIONS_IDENTITY.login },
		},
		{
			label: 'another bot edited reply',
			editor: { __typename: 'Bot', login: 'other-bot' },
		},
	] satisfies ReplyCase[])('$label does not close a thread', overrides => {
		expect(
			toBotThread(
				botClosedReviewThread({
					latest: {
						nodes: [
							threadReply({
								body: toMarkerComment('reply', {
									v: MARKER_VERSION,
									action: 'resolved',
									commit: 'a'.repeat(40),
									reply: 42,
								}),
								...overrides,
							}),
						],
					},
				}),
				OWNED
			)
		).toMatchObject({
			resolved: false,
			closedByBot: false,
			closedAt: undefined,
		})
	})

	test('a reply edited by the bot itself still closes its thread', () => {
		expect(
			toBotThread(
				botClosedReviewThread({
					latest: {
						nodes: [
							threadReply({
								editor: {
									__typename: 'Bot',
									login: GITHUB_ACTIONS_IDENTITY.login,
								},
							}),
						],
					},
				}),
				OWNED
			)
		).toMatchObject({ resolved: true, closedByBot: true })
	})

	test('a bot-closed bug contributes no open bugs, permits a ready verdict and is not a recheck candidate', () => {
		const thread = toBotThread(botClosedReviewThread(), OWNED)
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

describe('ownership across a switch', () => {
	test.each([
		{ editor: null, owned: true },
		{ editor: { __typename: 'Bot', login: 'GITHUB-ACTIONS' }, owned: true },
		{ editor: { __typename: 'Bot', login: APP_IDENTITY.login }, owned: false },
		{ editor: { __typename: 'User', login: 'github-actions' }, owned: false },
	])('same author editor rule: $editor', ({ editor, owned }) => {
		expect(
			isBotComment(
				{ author: { __typename: 'Bot', login: 'GitHub-Actions' }, editor },
				APP_MODE_IDENTITIES
			)
		).toBe(owned)
	})
	test.each(['other-app', 'mng-review', 'github-actions'])(
		'a copied marker from %s cannot claim ownership',
		login => {
			const thread = reviewThread()
			expect(
				toBotThread(
					{
						...thread,
						comments: {
							...thread.comments,
							nodes: thread.comments.nodes.map(comment => ({
								...comment,
								author: {
									__typename: login === 'other-app' ? 'Bot' : 'User',
									login,
								},
							})),
						},
					},
					APP_MODE_IDENTITIES
				)
			).toBeUndefined()
		}
	)
	test('an app closing reply closes an earlier job-token thread', () => {
		expect(
			toBotThread(
				botClosedReviewThread({
					latest: {
						nodes: [
							threadReply({
								author: { __typename: 'Bot', login: APP_IDENTITY.login },
							}),
						],
					},
				}),
				APP_MODE_IDENTITIES
			)
		).toMatchObject({ resolved: true, closedByBot: true })
	})
})

describe('full review completion', () => {
	test.each([
		{ previous: undefined, finished: false },
		{ previous: { head: 'head' }, finished: false },
		{ previous: { head: 'head', finished: false }, finished: false },
		{ previous: { finished: true }, finished: false },
		{ previous: { head: 'old-head', finished: true }, finished: false },
		{ previous: { head: 'head', finished: true }, finished: true },
	])(
		'single-agent completion inherits $previous as $finished',
		({ previous, finished }) => {
			for (const endpointError of [undefined, 'offline'])
				expect(
					isFullReview({ ...report(), endpointError }, previous, {
						head: 'head',
						partial: true,
					})
				).toBe(finished)
		}
	)
	test.each([
		{ label: 'complete', reviewed: report(), finished: true },
		{
			label: 'endpoint failure',
			reviewed: { ...report(), endpointError: 'offline' },
			finished: false,
		},
		{
			label: 'budget stop',
			reviewed: {
				...report(),
				incomplete: { reason: 'budget', unfinished: [] },
			},
			finished: false,
		},
		{
			label: 'failed agent',
			reviewed: { ...report(), agents: [agentReport('failed')] },
			finished: false,
		},
		{
			label: 'incomplete agent',
			reviewed: { ...report(), agents: [agentReport('incomplete')] },
			finished: false,
		},
	])(
		'full run completion follows the current report: $label',
		({ reviewed, finished }) => {
			expect(
				isFullReview(
					reviewed,
					{ head: 'head', finished: !finished },
					{ head: 'head', partial: false }
				)
			).toBe(finished)
		}
	)
	test.each([
		{ finished: false, openBugs: 0, verdict: 'incomplete' },
		{ finished: true, openBugs: 0, verdict: 'ready' },
		{ finished: false, openBugs: 1, verdict: 'needs fixes' },
		{ finished: true, openBugs: 1, verdict: 'needs fixes' },
	])(
		'explicit completion $finished with $openBugs bugs produces $verdict',
		({ finished, openBugs, verdict }) => {
			expect(
				getVerdict(
					{ ...report(), endpointError: finished ? 'offline' : undefined },
					openBugs,
					finished
				)
			).toBe(verdict)
		}
	)
})

interface OwnerAnswerCase {
	readonly label: string
	readonly overrides: Partial<ThreadComment>
	readonly expected: boolean
}

describe('owner answers in recent comments', () => {
	test('an earlier owned answer sets sentToOwner while the last comment supplies reply fields', () => {
		const raw = ownerReviewThread()
		const latest = raw.latest?.nodes.at(-1)
		expect(toBotThread(raw, OWNED)).toMatchObject({
			sentToOwner: true,
			latestCommentId: latest?.databaseId,
			latestAuthor: { type: 'User', login: 'contributor' },
			latestDigest: toBodyDigest(latest?.body ?? ''),
			resolved: false,
		})
	})
	test.each([
		{ label: 'owned unedited bot', overrides: {}, expected: true },
		{
			label: 'self edited bot',
			overrides: {
				editor: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
			},
			expected: true,
		},
		{
			label: 'previous owned identity',
			overrides: { author: { __typename: 'Bot', login: APP_IDENTITY.login } },
			expected: true,
		},
		{
			label: 'user pasted marker',
			overrides: {
				author: { __typename: 'User', login: GITHUB_ACTIONS_IDENTITY.login },
			},
			expected: false,
		},
		{
			label: 'foreign bot',
			overrides: { author: { __typename: 'Bot', login: 'other-bot' } },
			expected: false,
		},
		{
			label: 'human editor',
			overrides: { editor: { __typename: 'User', login: 'contributor' } },
			expected: false,
		},
		{
			label: 'another owned bot editor',
			overrides: { editor: { __typename: 'Bot', login: APP_IDENTITY.login } },
			expected: false,
		},
	] satisfies readonly OwnerAnswerCase[])(
		'$label determines whether an owner answer counts',
		({ overrides, expected }) => {
			const comments = [
				markedThreadReply('needs-owner', overrides),
				threadReply({ body: 'Later context' }),
			]
			expect(hasOwnerAnswer(comments, APP_MODE_IDENTITIES)).toBe(expected)
			expect(
				toBotThread(
					ownerReviewThread(1, { latest: { nodes: comments } }),
					APP_MODE_IDENTITIES
				)?.sentToOwner
			).toBe(expected)
		}
	)
	test('other reply actions and empty comments do not send a thread to the owner', () => {
		expect(
			hasOwnerAnswer([markedThreadReply('disputed'), threadReply()], OWNED)
		).toBe(false)
		expect(hasOwnerAnswer([], OWNED)).toBe(false)
	})
})

describe('raw owner thread discovery', () => {
	test.each([false, true])(
		'getOwnerAnswered finds answers after an edited root, resolved=%s',
		isResolved => {
			const edited = editedOwnerReviewThread(1, { id: 'edited', isResolved })
			const human = ownerReviewThread(1, {
				id: 'human-root',
				comments: {
					...edited.comments,
					nodes: edited.comments.nodes.map(comment => ({
						...comment,
						author: { __typename: 'User', login: 'contributor' },
					})),
				},
			})
			expect(toBotThread(edited, OWNED)).toBeUndefined()
			expect(toBotThread(human, OWNED)).toBeUndefined()
			expect(getOwnerAnswered([edited, human], OWNED)).toEqual([
				'edited',
				'human-root',
			])
		}
	)
	test('getOwnerAnswered rejects forged and edited answers and tolerates absent latest comments', () => {
		const threads = [
			ownerReviewThread(1, {
				id: 'forged',
				latest: {
					nodes: [
						markedThreadReply('needs-owner', {
							author: {
								__typename: 'User',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						}),
					],
				},
			}),
			ownerReviewThread(1, {
				id: 'edited',
				latest: {
					nodes: [
						markedThreadReply('needs-owner', {
							editor: { __typename: 'User', login: 'contributor' },
						}),
					],
				},
			}),
			ownerReviewThread(1, {
				id: 'disputed',
				latest: { nodes: [markedThreadReply('disputed')] },
			}),
			ownerReviewThread(1, { id: 'absent', latest: undefined }),
			ownerReviewThread(1, { id: 'empty', latest: { nodes: [] } }),
		]
		expect(getOwnerAnswered(threads, OWNED)).toEqual([])
	})
	test('getUnreadOwnerThreads selects long edited bot roots but never human or foreign roots', () => {
		const edited = editedOwnerReviewThread(RECENT_COMMENTS, {
			id: 'edited',
			isResolved: true,
		})
		const human = {
			...edited,
			id: 'human',
			comments: {
				...edited.comments,
				nodes: edited.comments.nodes.map(comment => ({
					...comment,
					author: { __typename: 'User', login: GITHUB_ACTIONS_IDENTITY.login },
				})),
			},
		}
		const foreign = {
			...edited,
			id: 'foreign',
			comments: {
				...edited.comments,
				nodes: edited.comments.nodes.map(comment => ({
					...comment,
					author: { __typename: 'Bot', login: 'other-bot' },
				})),
			},
		}
		expect(getUnreadOwnerThreads([edited, human, foreign], OWNED)).toEqual([
			edited,
		])
	})
	test('getUnreadOwnerThreads skips boundary threads, known answers, owned nits and empty roots', () => {
		const nit = reviewThread({ finding: bug(), kind: 'nit' })
		expect(
			getUnreadOwnerThreads(
				[
					rawThread('boundary', RECENT_COMMENTS),
					ownerReviewThread(1, {
						comments: {
							...reviewThread().comments,
							totalCount: RECENT_COMMENTS + 1,
						},
					}),
					{
						...nit,
						comments: { ...nit.comments, totalCount: RECENT_COMMENTS + 1 },
					},
					reviewThread(undefined, {
						comments: { totalCount: RECENT_COMMENTS + 1, nodes: [] },
					}),
				],
				OWNED
			)
		).toEqual([])
	})
})

/** An answer the app wrote, its marker carrying `unsettled` when asked. */
function appAnswer(
	unsettled: boolean,
	overrides: Partial<ThreadComment> = {}
): ThreadComment {
	return threadReply({
		author: { __typename: 'Bot', login: APP_IDENTITY.login },
		body: toMarkerComment('reply', {
			v: MARKER_VERSION,
			action: 'still-found',
			commit: 'a'.repeat(40),
			reply: 42,
			...(unsettled ? { unsettled: true as const } : {}),
		}),
		...overrides,
	})
}

/** A resolved app thread whose latest window holds `latest`, `totalCount` comments in all. */
function resolvedWith(
	latest: readonly ThreadComment[],
	totalCount = latest.length + 1
) {
	return reviewThread(undefined, {
		isResolved: true,
		comments: { ...reviewThread().comments, totalCount },
		latest: { nodes: latest },
	})
}

describe('unsettled answers', () => {
	test('the newest answer of the token app decides whether a thread is unsettled', () => {
		const person = threadReply({
			author: { __typename: 'User', login: 'writer' },
			body: 'still broken',
		})
		expect(
			toBotThread(resolvedWith([appAnswer(true), person]), APP_MODE_IDENTITIES)
				?.unsettled
		).toBe(true)
		expect(
			toBotThread(
				resolvedWith([appAnswer(true), appAnswer(false)]),
				APP_MODE_IDENTITIES
			)?.unsettled
		).toBe(false)
		expect(
			toBotThread(resolvedWith([person]), APP_MODE_IDENTITIES)?.unsettled
		).toBe(false)
	})
	test('an unsettled answer of another owned identity or one someone else edited is ignored', () => {
		const jobToken = appAnswer(true, {
			author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
		})
		const edited = appAnswer(true, {
			editor: { __typename: 'User', login: 'writer' },
		})
		for (const answer of [jobToken, edited])
			expect(
				toBotThread(resolvedWith([answer]), APP_MODE_IDENTITIES)?.unsettled
			).toBe(false)
	})
	test('a thread longer than its windows without an app answer in the latest one is left unknown', () => {
		const person = threadReply({
			author: { __typename: 'User', login: 'writer' },
			body: 'later',
		})
		const window = Array.from({ length: RECENT_COMMENTS }, () => person)
		expect(
			toBotThread(
				resolvedWith(window, RECENT_COMMENTS + 2),
				APP_MODE_IDENTITIES
			)?.unsettled
		).toBeUndefined()
		expect(
			toBotThread(
				resolvedWith(
					[...window.slice(1), appAnswer(true)],
					RECENT_COMMENTS + 2
				),
				APP_MODE_IDENTITIES
			)?.unsettled
		).toBe(true)
		expect(isUnsettled([appAnswer(true), ...window], APP_IDENTITY)).toBeTruthy()
		expect(isUnsettled(window, APP_IDENTITY)).toBe(false)
	})
})
