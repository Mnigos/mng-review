import { layer } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { RECENT_COMMENTS } from '../../../platform/github-api.constants'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	makeGitHubHttp,
	getGitHubRequestBody,
	GITHUB_SETTINGS,
} from '../../../shared/mocks/github-http.helper'
import {
	githubStatusFake,
	openPullRequest,
} from '../../../shared/mocks/github-status-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	appSummary,
	reviewThread,
	summaryReview,
	botClosedReviewThread,
	bug,
	SUMMARY_MARKER,
	TOKEN_MODE_OWNED,
} from '../../../shared/mocks/publish-test.helper'
import {
	editedOwnerReviewThread,
	markedThreadReply,
	ownerReviewThread,
} from '../../../shared/mocks/thread-reply-test.helper'
import {
	SummaryReviewService,
	SummaryReviewServiceLive,
} from '../../publish/application/summary-review.service'
import { parseSummaryMarker } from '../../publish/domain/publish-marker.parser'
import { toClearedMessage } from '../../publish/presentation/summary-status.formatter'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import {
	type CommitStatusText,
	toCommitStatus,
	UNFINISHED_NOTE,
} from '../domain/status.helper'
import {
	StatusSweepService,
	StatusSweepServiceLive,
} from './status-sweep.service'

const NO_DISMISSAL = { dismissed: 0, failed: 0 } as const

layer(TOKEN_MODE_OWNED)('StatusSweepService', test => {
	test.effect(
		'heads without a bot status are skipped without reading their threads',
		() =>
			Effect.gen(function* () {
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(1, 'unknown')]),
				})
				const api = githubApiFake()
				const listReviewThreadsSpy = vi.fn(() =>
					Effect.die('unreviewed pull must not be read')
				)
				const apiLayer = Layer.effect(
					GitHubApiService,
					GitHubApiService.pipe(
						Effect.map(service => ({
							...service,
							listReviewThreads: listReviewThreadsSpy,
						}))
					)
				).pipe(Layer.provide(api.api))
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.mergeAll(fake.layer, apiLayer, api.api))
							)
						)
					)
				).toEqual({
					checked: 0,
					updated: 0,
					failed: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(listReviewThreadsSpy).not.toHaveBeenCalled()
				expect(fake.statuses).toEqual([])
			})
	)
	for (const kind of [
		'resolved',
		'bot-closed',
		'human-after-bot',
		'unverified',
		'nit',
		'foreign',
		'edited',
		'open',
	] as const)
		test.effect(`sweep counts ${kind} threads`, () =>
			Effect.gen(function* () {
				const api = githubApiFake()
				const thread = reviewThread(
					{
						finding: bug(),
						kind: kind === 'unverified' || kind === 'nit' ? kind : 'bug',
					},
					{ isResolved: kind === 'resolved' }
				)
				const closed = botClosedReviewThread()
				api.threads.push(
					kind === 'bot-closed'
						? closed
						: kind === 'human-after-bot'
							? {
									...closed,
									comments: { ...closed.comments, totalCount: 3 },
									latest: {
										nodes:
											closed.latest?.nodes.map(comment => ({
												...comment,
												author: { __typename: 'User', login: 'contributor' },
											})) ?? [],
									},
								}
							: kind === 'foreign' || kind === 'edited'
								? {
										...thread,
										comments: {
											...thread.comments,
											nodes: thread.comments.nodes.map(comment => ({
												...comment,
												...(kind === 'foreign'
													? {
															author: {
																__typename: 'User',
																login: 'contributor',
															},
														}
													: {
															editor: {
																__typename: 'User',
																login: 'contributor',
															},
														}),
											})),
										},
									}
								: thread
				)
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(1, 'head')]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							state: 'failure',
							description: 'stale',
							context: 'MNG Review',
							creator: { login: 'github-actions[bot]', type: 'Bot' },
						}),
				})
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fake.layer, api.api))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 1,
					failed: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(fake.statuses).toContainEqual(
					expect.objectContaining({
						sha: 'head',
						state:
							kind === 'open' || kind === 'human-after-bot'
								? 'failure'
								: 'success',
					})
				)
				expect(api.writes).toEqual([])
			})
		)
	for (const failureAt of ['read', 'write'] as const)
		test.effect(
			`a failed ${failureAt} counts as failed and does not stop the next pull`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake()
					const error = new GitHubApiError({
						operation: failureAt,
						reason: 'denied',
						status: 403,
					})
					const fake = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([
								openPullRequest(1, 'first'),
								openPullRequest(2, 'second'),
							]),
						getStatus: sha =>
							failureAt === 'read' && sha === 'first'
								? Effect.fail(error)
								: Effect.succeed({
										id: 1,
										state: 'failure',
										description: null,
										context: 'MNG Review',
										creator: null,
									}),
						setStatus: input =>
							failureAt === 'write' && input.sha === 'first'
								? Effect.fail(error)
								: Effect.void,
					})
					expect(
						yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fake.layer, api.api))
								)
							)
						)
					).toEqual({
						checked: 2,
						updated: 1,
						failed: 1,
						dismissal: NO_DISMISSAL,
					})
					expect(fake.statuses).toContainEqual(
						expect.objectContaining({ sha: 'second', state: 'success' })
					)
				})
		)
})

layer(TOKEN_MODE_OWNED)('StatusSweepService latest status', test => {
	for (const latest of ['same', 'newer', 'gone', 'read-failed'] as const)
		test.effect(
			`a ${latest} status at the second read controls the write`,
			() =>
				Effect.gen(function* () {
					const previous = {
						id: 1,
						state: 'failure',
						description: 'stale',
						context: 'MNG Review',
						creator: null,
					}
					const getStatusSpy = vi
						.fn()
						.mockReturnValueOnce(Effect.succeed(previous))
						.mockReturnValueOnce(
							latest === 'read-failed'
								? Effect.fail(
										new GitHubApiError({ operation: 'read', reason: 'denied' })
									)
								: Effect.succeed(
										latest === 'gone'
											? undefined
											: { ...previous, id: latest === 'newer' ? 2 : 1 }
									)
						)
					const fake = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, 'head')]),
						getStatus: getStatusSpy,
					})
					const api = githubApiFake()
					expect(
						yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fake.layer, api.api))
								)
							)
						)
					).toEqual({
						checked: 1,
						updated: latest === 'same' ? 1 : 0,
						failed: latest === 'read-failed' ? 1 : 0,
						dismissal: NO_DISMISSAL,
					})
					expect(getStatusSpy.mock.calls).toEqual([['head'], ['head']])
					expect(api.threadReads).toEqual([17])
					expect(fake.statuses).toEqual(
						latest === 'same'
							? [
									{
										sha: 'head',
										state: 'success',
										description: 'no open bug thread',
									},
								]
							: []
					)
				})
		)
	test.effect(
		'resolving the last bug from an unfinished run never sweeps it green',
		() =>
			Effect.gen(function* () {
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							state: 'failure',
							description: `1 open bug thread(s); needs fixes; ${UNFINISHED_NOTE}`,
							context: 'MNG Review',
							creator: null,
						}),
				})
				const api = githubApiFake()
				api.threads.push(reviewThread(undefined, { isResolved: true }))
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fake.layer, api.api))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 1,
					failed: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(fake.statuses).toEqual([
					{
						sha: 'head',
						state: 'error',
						description: `no open bug thread; ${UNFINISHED_NOTE}`,
					},
				])
			})
	)
})

layer(TOKEN_MODE_OWNED)('StatusSweepService summary marker', test => {
	for (const scenario of [
		{
			name: 'matching head without a thread',
			head: 'head',
			openBugs: 0,
			expected: 2,
		},
		{
			name: 'matching head with an open bug',
			head: 'head',
			openBugs: 1,
			expected: 3,
		},
		{ name: 'another head', head: 'previous', openBugs: 0, expected: 0 },
		{ name: 'no reviewed head', head: undefined, openBugs: 0, expected: 0 },
	] as const)
		test.effect(`sweep counts unthreaded bugs for ${scenario.name}`, () =>
			Effect.gen(function* () {
				const api = githubApiFake()
				api.reviews.push({
					id: 'summary-node',
					databaseId: 101,
					state: 'COMMENTED',
					isMinimized: false,
					body: toMarkerComment('summary', {
						...SUMMARY_MARKER,
						head: scenario.head,
						finished: true,
						unthreadedBugs: 2,
					}),
					author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
					editor: null,
				})
				if (scenario.openBugs > 0) api.threads.push(reviewThread())
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							state: 'failure',
							description: 'stale',
							context: 'MNG Review',
							creator: null,
						}),
				})
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fake.layer, api.api))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 1,
					failed: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(fake.statuses).toEqual([
					{
						sha: 'head',
						...toCommitStatus(
							scenario.expected > 0 ? 'needs fixes' : 'ready',
							scenario.expected,
							scenario.head === 'head'
						),
					},
				])
				expect(api.writes).toEqual([])
			})
		)
	for (const finished of [true, false])
		for (const edited of [true, false])
			test.effect(
				`${edited ? 'bot-edited' : 'unedited'} summary with finished=${finished} repairs an overwritten status`,
				() =>
					Effect.gen(function* () {
						const api = githubApiFake()
						api.reviews.push({
							id: 'summary-node',
							databaseId: 101,
							state: 'COMMENTED',
							isMinimized: false,
							body: toMarkerComment('summary', { ...SUMMARY_MARKER, finished }),
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
							editor: edited
								? { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login }
								: null,
						})
						api.threads.push(reviewThread(undefined, { isResolved: true }))
						const previous = {
							id: 1,
							...toCommitStatus('ready', 0, !finished),
							context: 'MNG Review',
							creator: null,
						}
						const repaired = toCommitStatus('ready', 0, finished)
						const getStatusSpy = vi
							.fn()
							.mockReturnValueOnce(Effect.succeed(previous))
							.mockReturnValueOnce(Effect.succeed(previous))
							.mockReturnValue(
								Effect.succeed({ ...previous, ...repaired, id: 2 })
							)
						const fake = githubStatusFake({
							listOpenPullRequests: () =>
								Effect.succeed([openPullRequest(17, 'head')]),
							getStatus: getStatusSpy,
						})
						const sweeper = yield* StatusSweepService.pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fake.layer, api.api))
								)
							)
						)
						expect(yield* sweeper.sweep()).toEqual({
							checked: 1,
							updated: 1,
							failed: 0,
							dismissal: NO_DISMISSAL,
						})
						expect(fake.statuses).toEqual([{ sha: 'head', ...repaired }])
						expect(yield* sweeper.sweep()).toEqual({
							checked: 1,
							updated: 0,
							failed: 0,
							dismissal: NO_DISMISSAL,
						})
						expect(getStatusSpy.mock.calls).toEqual([
							['head'],
							['head'],
							['head'],
						])
						expect(fake.statuses).toHaveLength(1)
						expect(api.writes).toEqual([])
					})
			)
	for (const source of [
		'user-editor',
		'user-editor-bot-login',
		'user-author',
		'foreign-bot',
		'legacy',
		'invalid',
		'unmarked',
	] as const)
		test.effect(`${source} summary falls back to the existing status`, () =>
			Effect.gen(function* () {
				const api = githubApiFake()
				api.comments.push({
					id: 'summary-node',
					databaseId: 101,
					isMinimized: false,
					body:
						source === 'unmarked'
							? 'No summary marker'
							: toMarkerComment('summary', {
									...SUMMARY_MARKER,
									...(source === 'legacy'
										? {}
										: { finished: source === 'invalid' ? 'false' : false }),
								}),
					author:
						source === 'user-author'
							? { __typename: 'User', login: GITHUB_ACTIONS_IDENTITY.login }
							: {
									__typename: 'Bot',
									login:
										source === 'foreign-bot'
											? 'other-bot'
											: GITHUB_ACTIONS_IDENTITY.login,
								},
					editor:
						source === 'user-editor' || source === 'user-editor-bot-login'
							? {
									__typename: 'User',
									login:
										source === 'user-editor-bot-login'
											? GITHUB_ACTIONS_IDENTITY.login
											: 'contributor',
								}
							: null,
				})
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							...toCommitStatus('ready', 0, true),
							context: 'MNG Review',
							creator: null,
						}),
				})
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fake.layer, api.api))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 0,
					failed: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(fake.statuses).toEqual([])
				expect(api.writes).toEqual([])
			})
		)
})

layer(APP_MODE_OWNED)('StatusSweepService app mode', test => {
	test.effect(
		'finds the old job-token status, counts owned threads and summary, and writes with the app token',
		() =>
			Effect.gen(function* () {
				const previous = {
					id: 1,
					state: 'failure',
					description: 'stale',
					context: 'MNG Review',
					creator: { login: GITHUB_ACTIONS_IDENTITY.restLogin, type: 'Bot' },
				}
				const http = makeGitHubHttp(
					request =>
						Effect.succeed(
							Response.json(
								request.url.endsWith('/pulls')
									? [openPullRequest(17, 'head')]
									: request.method === 'POST'
										? { id: 2 }
										: [previous]
							)
						),
					{
						...GITHUB_SETTINGS,
						identity: APP_IDENTITY,
						token: Redacted.make('app-fixture'),
					}
				)
				const api = githubApiFake(APP_IDENTITY)
				api.threads.push(reviewThread())
				api.comments.push(
					appSummary(
						{
							...SUMMARY_MARKER,
							head: 'head',
							finished: true,
							unthreadedBugs: 2,
						},
						{
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						}
					)
				)
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(http.statusLayer, api.api))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 1,
					failed: 0,
					dismissal: NO_DISMISSAL,
				})
				const write = http.requests.find(request => request.method === 'POST')
				expect(write?.url).toContain('/statuses/head')
				expect(write?.headers.authorization).toBe('Bearer app-fixture')
				expect(write?.body).toMatchObject({ _tag: 'Uint8Array' })
				expect(getGitHubRequestBody(write)).toMatchObject({
					state: 'failure',
				})
				expect(JSON.stringify(getGitHubRequestBody(write))).toContain(
					'3 open bug'
				)
				expect(api.threadReads).toEqual([17])
				expect(api.writes).toEqual([])
			})
	)
})

layer(APP_MODE_OWNED)('StatusSweepService after an identity switch', test => {
	for (const cleanupFails of [false, true])
		test.effect(
			`an offline publish after switching to the app stays error when swept with the old summary ${cleanupFails ? 'visible' : 'hidden'}`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake(APP_IDENTITY)
					api.comments.push(
						appSummary(
							{ ...SUMMARY_MARKER, runs: 3, finished: true },
							{
								id: 'previous-summary',
								databaseId: 101,
								author: {
									__typename: 'Bot',
									login: GITHUB_ACTIONS_IDENTITY.login,
								},
							}
						)
					)
					if (cleanupFails)
						api.failures.minimize.push(
							new GitHubApiError({
								operation: 'minimize',
								reason: 'server error',
								status: 503,
							})
						)
					const summaryLayer = SummaryReviewServiceLive.pipe(
						Layer.provide(
							Layer.merge(
								api.api,
								Layer.succeed(GitHubConfig, {
									...GITHUB_SETTINGS,
									identity: APP_IDENTITY,
								})
							)
						)
					)
					expect(
						yield* SummaryReviewService.use(service =>
							service.publishStatus({
								pullNumber: 17,
								head: 'new-head',
								engineCommit: undefined,
								status: 'offline',
							})
						).pipe(Effect.provide(summaryLayer))
					).toMatchObject({ created: true })
					expect(
						parseSummaryMarker(
							api.reviews.find(
								comment => comment.author?.login === APP_IDENTITY.login
							)?.body ?? ''
						)
					).toEqual({ ...SUMMARY_MARKER, runs: 3, finished: false })
					const previous = {
						id: 1,
						...toCommitStatus('incomplete', 0, false),
						context: 'MNG Review',
						creator: { login: APP_IDENTITY.restLogin, type: 'Bot' },
					}
					const statuses = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, 'new-head')]),
						getStatus: () => Effect.succeed(previous),
					})
					expect(
						yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(statuses.layer, api.api))
								)
							)
						)
					).toEqual({
						checked: 1,
						updated: 0,
						failed: 0,
						dismissal: NO_DISMISSAL,
					})
					expect(statuses.statuses).toEqual([])
					expect(statuses.statuses.at(-1)?.state ?? previous.state).toBe(
						'error'
					)
					expect(api.writes.map(write => write.method)).toEqual([
						'review',
						'minimize',
					])
					expect(
						api.comments.find(comment => comment.databaseId === 101)
							?.isMinimized
					).toBe(!cleanupFails)
				})
		)
	for (const scenario of [
		{
			name: 'a previous finished marker for another head falls back to the error status',
			previousHead: 'older-head',
			previousFinished: true,
			own: false,
			expectedFinished: false,
		},
		{
			name: 'a previous finished marker for the same head is still used',
			previousHead: 'head',
			previousFinished: true,
			own: false,
			expectedFinished: true,
		},
		{
			name: 'a previous unfinished marker for the same head overrides successful status text',
			previousHead: 'head',
			previousFinished: false,
			own: false,
			expectedFinished: false,
		},
		{
			name: 'the current unfinished marker wins over a previous finished marker on the swept head',
			previousHead: 'head',
			previousFinished: true,
			own: true,
			expectedFinished: false,
		},
	] as const)
		test.effect(scenario.name, () =>
			Effect.gen(function* () {
				const api = githubApiFake(APP_IDENTITY)
				api.comments.push(
					appSummary(
						{
							...SUMMARY_MARKER,
							head: scenario.previousHead,
							finished: scenario.previousFinished,
						},
						{
							databaseId: 101,
							id: 'previous-summary',
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						}
					)
				)
				if (scenario.own)
					api.comments.push(
						appSummary({
							...SUMMARY_MARKER,
							head: 'older-head',
							finished: false,
						})
					)
				const statuses = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							state:
								scenario.own || !scenario.previousFinished
									? 'success'
									: 'error',
							description: 'stale',
							context: 'MNG Review',
							creator: {
								login: GITHUB_ACTIONS_IDENTITY.restLogin,
								type: 'Bot',
							},
						}),
				})
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(statuses.layer, api.api))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 1,
					failed: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(statuses.statuses).toEqual([
					{
						sha: 'head',
						...toCommitStatus('ready', 0, scenario.expectedFinished),
					},
				])
				expect(api.writes).toEqual([])
			})
		)
})

layer(APP_MODE_OWNED)(
	'StatusSweepService visible current identity duplicates',
	test => {
		for (const state of ['error', 'failure', 'success'] as const)
			for (const hidden of [false, true])
				test.effect(
					`${hidden ? 'repairs' : 'keeps'} ${state} while a current identity duplicate is ${hidden ? 'hidden' : 'visible'}`,
					() =>
						Effect.gen(function* () {
							const api = githubApiFake(APP_IDENTITY)
							const finished = state !== 'success'
							api.comments.push(
								appSummary({ ...SUMMARY_MARKER, head: 'head', finished }),
								appSummary(
									{ ...SUMMARY_MARKER, head: 'head', finished: !finished },
									{ id: 'newer-summary', databaseId: 102, isMinimized: hidden }
								)
							)
							const getStatusSpy = vi.fn(() =>
								Effect.succeed({
									id: 1,
									state,
									description: 'stale',
									context: 'MNG Review',
									creator: { login: APP_IDENTITY.restLogin, type: 'Bot' },
								})
							)
							const statuses = githubStatusFake({
								listOpenPullRequests: () =>
									Effect.succeed([openPullRequest(17, 'head')]),
								getStatus: getStatusSpy,
							})
							expect(
								yield* StatusSweepService.use(service => service.sweep()).pipe(
									Effect.provide(
										StatusSweepServiceLive.pipe(
											Layer.provide(Layer.merge(statuses.layer, api.api))
										)
									)
								)
							).toEqual({
								checked: 1,
								updated: hidden ? 1 : 0,
								failed: 0,
								dismissal: NO_DISMISSAL,
							})
							expect(statuses.statuses).toEqual(
								hidden
									? [{ sha: 'head', ...toCommitStatus('ready', 0, finished) }]
									: []
							)
							expect(getStatusSpy).toHaveBeenCalledTimes(hidden ? 2 : 1)
							expect(api.commentReads).toEqual([17])
							expect(api.writes).toEqual([])
						})
				)
	}
)

layer(TOKEN_MODE_OWNED)('StatusSweepService review head', test => {
	for (const head of ['older-head', undefined])
		test.effect(
			`a finished summary on ${head} does not complete the current head`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake()
					api.comments.push({
						id: 'summary-node',
						isMinimized: false,
						databaseId: 101,
						body: toMarkerComment('summary', {
							...SUMMARY_MARKER,
							head,
							finished: true,
						}),
						author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
						editor: null,
					})
					const fake = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, 'head')]),
						getStatus: () =>
							Effect.succeed({
								id: 1,
								...toCommitStatus('ready', 0, true),
								context: 'MNG Review',
								creator: null,
							}),
					})
					expect(
						yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fake.layer, api.api))
								)
							)
						)
					).toEqual({
						checked: 1,
						updated: 1,
						failed: 0,
						dismissal: NO_DISMISSAL,
					})
					expect(fake.statuses).toEqual([
						{ sha: 'head', ...toCommitStatus('incomplete', 0, false) },
					])
					expect(api.writes).toEqual([])
				})
		)
	for (const finished of [false, true])
		test.effect(
			`a legacy marker preserves an existing ${finished ? 'finished' : 'unfinished'} status`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake()
					api.comments.push({
						id: 'summary-node',
						isMinimized: false,
						databaseId: 101,
						body: toMarkerComment('summary', {
							...SUMMARY_MARKER,
							head: 'older-head',
						}),
						author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
						editor: null,
					})
					const getStatusSpy = vi.fn(() =>
						Effect.succeed({
							id: 1,
							...toCommitStatus('ready', 0, finished),
							context: 'MNG Review',
							creator: null,
						})
					)
					const fake = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, 'head')]),
						getStatus: getStatusSpy,
					})
					expect(
						yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fake.layer, api.api))
								)
							)
						)
					).toEqual({
						checked: 1,
						updated: 0,
						failed: 0,
						dismissal: NO_DISMISSAL,
					})
					expect(getStatusSpy).toHaveBeenCalledExactlyOnceWith('head')
					expect(fake.statuses).toEqual([])
					expect(api.writes).toEqual([])
				})
		)
})

layer(TOKEN_MODE_OWNED)('StatusSweepService unthreaded bugs', test => {
	for (const scenario of [
		{
			name: 'single-agent bug after a clean full review',
			finished: true,
			unthreadedBugs: 1,
		},
		{
			name: 'unfinished full review carrying two bugs',
			finished: false,
			unthreadedBugs: 2,
		},
		{
			name: 'unfinished full review adding a third bug',
			finished: false,
			unthreadedBugs: 3,
		},
	] as const)
		test.effect(
			`sweep keeps failure for ${scenario.name} without any open thread`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake()
					const marker = {
						v: SUMMARY_MARKER.v,
						runs: 2,
						head: 'head',
						finished: scenario.finished,
						unthreadedBugs: scenario.unthreadedBugs,
					}
					api.comments.push({
						id: 'summary-node',
						databaseId: 101,
						isMinimized: false,
						body: toMarkerComment('summary', marker),
						author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
						editor: null,
					})
					const previous = {
						id: 1,
						state: 'failure',
						description: `${scenario.unthreadedBugs} open bug thread(s); needs fixes${scenario.finished ? '' : `; ${UNFINISHED_NOTE}`}`,
						context: 'MNG Review',
						creator: null,
					}
					const fake = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, 'head')]),
						getStatus: () => Effect.succeed(previous),
					})
					expect(
						yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fake.layer, api.api))
								)
							)
						)
					).toEqual({
						checked: 1,
						updated: 0,
						failed: 0,
						dismissal: NO_DISMISSAL,
					})
					expect(api.threads).toEqual([])
					expect(api.threadReads).toEqual([17])
					expect(fake.statuses).toEqual([])
					expect(fake.statuses.at(-1)?.state ?? previous.state).toBe('failure')
					expect(api.writes).toEqual([])
					expect(parseSummaryMarker(api.comments[0]?.body ?? '')).toEqual(
						marker
					)
				})
		)

	for (const markerHead of ['head', 'other-head', undefined])
		for (const threadBugs of [0, 1])
			test.effect(
				`sweep counts unthreaded bugs on ${markerHead} alongside ${threadBugs} open threads`,
				() =>
					Effect.gen(function* () {
						const api = githubApiFake()
						api.comments.push({
							id: 'summary-node',
							isMinimized: false,
							databaseId: 101,
							body: toMarkerComment('summary', {
								...SUMMARY_MARKER,
								head: markerHead,
								finished: true,
								unthreadedBugs: 2,
							}),
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
							editor: null,
						})
						if (threadBugs) api.threads.push(reviewThread())
						const previous = {
							id: 1,
							...toCommitStatus('needs fixes', 2 + threadBugs, true),
							context: 'MNG Review',
							creator: null,
						}
						const fake = githubStatusFake({
							listOpenPullRequests: () =>
								Effect.succeed([openPullRequest(17, 'head')]),
							getStatus: () => Effect.succeed(previous),
						})
						expect(
							yield* StatusSweepService.use(service => service.sweep()).pipe(
								Effect.provide(
									StatusSweepServiceLive.pipe(
										Layer.provide(Layer.merge(fake.layer, api.api))
									)
								)
							)
						).toEqual({
							checked: 1,
							updated: markerHead === 'head' ? 0 : 1,
							failed: 0,
							dismissal: NO_DISMISSAL,
						})
						expect(fake.statuses).toEqual(
							markerHead === 'head'
								? []
								: [
										{
											sha: 'head',
											...toCommitStatus(
												threadBugs ? 'needs fixes' : 'incomplete',
												threadBugs,
												false
											),
										},
									]
						)
						expect(api.writes).toEqual([])
					})
			)
	test.effect(
		'sweep restores failure when the status lost a same-head unthreaded bug',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake()
				api.comments.push({
					id: 'summary-node',
					isMinimized: false,
					databaseId: 101,
					body: toMarkerComment('summary', {
						...SUMMARY_MARKER,
						finished: true,
						unthreadedBugs: 1,
					}),
					author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
					editor: null,
				})
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							...toCommitStatus('ready', 0, true),
							context: 'MNG Review',
							creator: null,
						}),
				})
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fake.layer, api.api))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 1,
					failed: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(fake.statuses).toEqual([
					{ sha: 'head', ...toCommitStatus('needs fixes', 1, true) },
				])
				expect(api.writes).toEqual([])
			})
	)
})

layer(TOKEN_MODE_OWNED)('StatusSweepService owner escalation', test => {
	for (const [role, allow, cleared] of [
		['write', [], false],
		['admin', [], true],
		['write', ['contributor'], true],
		['read', ['contributor'], false],
	] as const)
		test.effect(
			`resolved by ${role}, allow=${allow.join(',')}, cleared=${cleared}`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake()
					api.command.role = role
					api.threads.push(
						reviewThread(undefined, {
							isResolved: true,
							resolvedBy: { login: 'contributor' },
						})
					)
					api.comments.push(
						appSummary(
							{ ...SUMMARY_MARKER, finished: true, needsOwner: ['thread'] },
							{
								author: {
									__typename: 'Bot',
									login: GITHUB_ACTIONS_IDENTITY.login,
								},
							}
						)
					)
					const before = structuredClone(api.comments)
					const fake = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, SUMMARY_MARKER.head)]),
						getStatus: () =>
							Effect.succeed({
								id: 1,
								state: 'failure',
								description: 'stale',
								context: 'MNG Review',
								creator: null,
							}),
					})
					expect(
						yield* StatusSweepService.use(service => service.sweep(allow)).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fake.layer, api.api))
								)
							)
						)
					).toEqual({
						checked: 1,
						updated: 1,
						failed: 0,
						dismissal: NO_DISMISSAL,
					})
					expect(fake.statuses).toEqual([
						{
							sha: SUMMARY_MARKER.head,
							...toCommitStatus(cleared ? 'ready' : 'needs owner', 0, true),
						},
					])
					expect(api.writes).toEqual([])
					expect(api.comments).toEqual(before)
				})
		)
})

layer(APP_MODE_OWNED)('StatusSweepService recovered owner state', test => {
	for (const scenario of [
		'hidden-summary',
		'recent-answer',
		'outside-window',
		'missing-summary',
		'edited-root',
	] as const)
		for (const resolver of ['writer', 'admin', 'allowed-writer'] as const)
			test.effect(
				`${scenario} stays failure for a writer and clears for an owner: ${resolver}`,
				() =>
					Effect.gen(function* () {
						const api = githubApiFake(APP_IDENTITY)
						api.command.role = resolver === 'admin' ? 'admin' : 'write'
						const raw =
							scenario === 'hidden-summary' || scenario === 'edited-root'
								? reviewThread()
								: ownerReviewThread(
										scenario === 'outside-window' ? RECENT_COMMENTS + 1 : 1
									)
						api.threads.push({
							...raw,
							isResolved: true,
							resolvedBy: { login: 'contributor' },
							...(scenario === 'edited-root'
								? {
										comments: {
											...raw.comments,
											nodes: raw.comments.nodes.map(comment => ({
												...comment,
												editor: { __typename: 'User', login: 'editor' },
											})),
										},
									}
								: {}),
						})
						if (scenario === 'outside-window')
							api.threadComments.set('thread', [
								markedThreadReply(),
								...(raw.latest?.nodes ?? []),
							])
						if (scenario !== 'missing-summary')
							api.comments.push(
								appSummary(
									{
										...SUMMARY_MARKER,
										head: 'head',
										finished: true,
										...(scenario === 'hidden-summary' ||
										scenario === 'edited-root'
											? { needsOwner: ['thread'] }
											: {}),
									},
									{ isMinimized: true }
								)
							)
						const previous = {
							id: 1,
							state: 'failure',
							description: 'stale',
							context: 'MNG Review',
							creator: null,
						}
						const statusHistory: ReturnType<typeof toCommitStatus>[] = []
						const statuses = githubStatusFake({
							setStatus: input =>
								Effect.sync(() => {
									statusHistory.push(input)
								}),
							listOpenPullRequests: () =>
								Effect.succeed([openPullRequest(17, 'head')]),
							getStatus: () =>
								Effect.succeed({ ...previous, ...statusHistory.at(-1) }),
						})
						const sweeper = yield* StatusSweepService.pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(statuses.layer, api.api))
								)
							)
						)
						const allow = resolver === 'allowed-writer' ? ['CONTRIBUTOR'] : []
						expect(yield* sweeper.sweep(allow)).toEqual({
							checked: 1,
							updated: 1,
							failed: 0,
							dismissal: NO_DISMISSAL,
						})
						expect(statuses.statuses).toEqual([
							{
								sha: 'head',
								...toCommitStatus(
									resolver === 'writer' ? 'needs owner' : 'ready',
									0,
									true
								),
							},
						])
						expect(yield* sweeper.sweep(allow)).toEqual({
							checked: 1,
							updated: 0,
							failed: 0,
							dismissal: NO_DISMISSAL,
						})
						expect(statuses.statuses).toHaveLength(1)
						expect(api.writes).toEqual([])
						expect(
							api.reads.filter(read => read.startsWith('listThreadComments:'))
						).toEqual(
							// Each sweep reads it whole for its bug count and the owner answer and, for an
							// owner's resolution, again for an unsettled answer.
							scenario === 'outside-window'
								? Array.from(
										{ length: resolver === 'writer' ? 4 : 6 },
										() => 'listThreadComments:thread'
									)
								: []
						)
					})
			)
	test.effect(
		'a failed whole-thread read counts as failed and leaves the status unchanged',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake(APP_IDENTITY)
				api.threads.push(
					ownerReviewThread(RECENT_COMMENTS + 1, {
						isResolved: true,
						resolvedBy: { login: 'contributor' },
					})
				)
				api.comments.push(
					appSummary(
						{ ...SUMMARY_MARKER, needsOwner: ['thread'] },
						{ isMinimized: true }
					)
				)
				const unavailable = new GitHubApiError({
					operation: 'listThreadComments',
					reason: 'unavailable',
					status: 503,
				})
				// The bug count's read and the owner answer's read both fail.
				api.failures.listThreadComments.push(unavailable, unavailable)
				const getStatusSpy = vi.fn(() =>
					Effect.succeed({
						id: 1,
						state: 'failure',
						description: 'Waiting for owner',
						context: 'MNG Review',
						creator: null,
					})
				)
				const statuses = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: getStatusSpy,
				})
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(statuses.layer, api.api))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 0,
					failed: 1,
					dismissal: NO_DISMISSAL,
				})
				expect(getStatusSpy).toHaveBeenCalledTimes(1)
				expect(statuses.statuses).toEqual([])
				expect(api.writes).toEqual([])
			})
	)
})

layer(TOKEN_MODE_OWNED)('StatusSweepService edited waiting threads', test => {
	for (const listed of [false, true])
		for (const resolver of ['writer', 'admin', 'allowed-writer'] as const)
			for (const initialState of ['success', 'failure'] as const)
				test.effect(
					`an edited root resolved by ${resolver} ${listed ? 'with' : 'without'} a summary waiting id repairs ${initialState}`,
					() =>
						Effect.gen(function* () {
							const api = githubApiFake()
							api.command.role = resolver === 'admin' ? 'admin' : 'write'
							api.threads.push(
								editedOwnerReviewThread(1, {
									isResolved: true,
									resolvedBy: { login: 'contributor' },
								})
							)
							api.comments.push(
								appSummary(
									{
										...SUMMARY_MARKER,
										head: 'head',
										finished: true,
										...(listed ? { needsOwner: ['thread'] } : {}),
									},
									{
										author: {
											__typename: 'Bot',
											login: GITHUB_ACTIONS_IDENTITY.login,
										},
									}
								)
							)
							const before = structuredClone(api.comments)
							const statuses = githubStatusFake({
								listOpenPullRequests: () =>
									Effect.succeed([openPullRequest(17, 'head')]),
								getStatus: () =>
									Effect.succeed({
										id: 1,
										state: initialState,
										description: 'stale',
										context: 'MNG Review',
										creator: null,
									}),
							})
							expect(
								yield* StatusSweepService.use(service =>
									service.sweep(
										resolver === 'allowed-writer' ? ['CONTRIBUTOR'] : []
									)
								).pipe(
									Effect.provide(
										StatusSweepServiceLive.pipe(
											Layer.provide(Layer.merge(statuses.layer, api.api))
										)
									)
								)
							).toEqual({
								checked: 1,
								updated: 1,
								failed: 0,
								dismissal: NO_DISMISSAL,
							})
							expect(statuses.statuses).toEqual([
								{
									sha: 'head',
									...toCommitStatus(
										resolver === 'writer' ? 'needs owner' : 'ready',
										0,
										true
									),
								},
							])
							expect(statuses.statuses.at(-1)?.state).toBe(
								resolver === 'writer' ? 'failure' : 'success'
							)
							expect(api.comments).toEqual(before)
							expect(api.writes).toEqual([])
						})
				)
	test.effect(
		'a long edited root recovers a needs-owner answer outside the latest comments without a summary waiting id',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake()
				api.command.role = 'write'
				const raw = editedOwnerReviewThread(RECENT_COMMENTS, {
					isResolved: true,
					resolvedBy: { login: 'contributor' },
				})
				api.threads.push(raw)
				api.threadComments.set('thread', [
					markedThreadReply(),
					...(raw.latest?.nodes ?? []),
				])
				api.comments.push(
					appSummary(
						{ ...SUMMARY_MARKER, head: 'head', finished: true },
						{
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						}
					)
				)
				const statuses = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							...toCommitStatus('ready', 0, true),
							context: 'MNG Review',
							creator: null,
						}),
				})
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(statuses.layer, api.api))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 1,
					failed: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(statuses.statuses).toEqual([
					{ sha: 'head', ...toCommitStatus('needs owner', 0, true) },
				])
				expect(
					api.reads.filter(read => read.startsWith('listThreadComments:'))
				).toEqual(['listThreadComments:thread'])
				expect(api.writes).toEqual([])
			})
	)
})

/** The in-memory GitHub a sweep spec reads. */
type ApiFake = ReturnType<typeof githubApiFake>

/** Points the fake's pull request read at `head`, the head the sweep listed. */
function onListedHead(api: ApiFake, head = 'head'): ApiFake {
	const { pullRequest } = api.command
	api.command.pullRequest = {
		...pullRequest,
		head: { ...pullRequest.head, sha: head },
	}
	return api
}

/** An open pull request on `head` whose own summary marks it finished, and its status. */
function sweepSetup(statuses: readonly CommitStatusText[]) {
	const api = onListedHead(githubApiFake(APP_IDENTITY))
	const author = { __typename: 'Bot', login: APP_IDENTITY.login } as const
	api.reviews.push(
		summaryReview(
			{ ...SUMMARY_MARKER, head: 'head', finished: true },
			{ databaseId: 101, author }
		)
	)
	const getStatusSpy = vi.fn((_sha: string) =>
		Effect.succeed({
			id: getStatusSpy.mock.calls.length,
			...(statuses[getStatusSpy.mock.calls.length - 1] ??
				statuses.at(-1) ??
				toCommitStatus('ready', 0, true)),
			context: 'MNG Review',
			creator: null,
		})
	)
	const status = githubStatusFake({
		listOpenPullRequests: () => Effect.succeed([openPullRequest(17, 'head')]),
		getStatus: getStatusSpy,
	})
	const request = summaryReview(SUMMARY_MARKER, {
		databaseId: 102,
		state: 'CHANGES_REQUESTED',
		author,
	})
	const sweep = StatusSweepService.use(service => service.sweep()).pipe(
		Effect.provide(
			StatusSweepServiceLive.pipe(
				Layer.provide(Layer.merge(api.api, status.layer))
			)
		)
	)
	return { api, status, request, sweep }
}

layer(APP_MODE_OWNED)('StatusSweepService review dismissals', test => {
	for (const standing of ['success', 'failure', 'error'] as const)
		for (const denied of [false, true])
			test.effect(
				`sweep standing=${standing} with dismissal denied=${denied} dismisses only current change requests`,
				() =>
					Effect.gen(function* () {
						// Nothing on the head backs a change request unless a bug thread is open.
						const unbacked = standing !== 'failure'
						const api = onListedHead(githubApiFake(APP_IDENTITY))
						api.reviews.push(
							summaryReview(
								{ ...SUMMARY_MARKER, finished: standing !== 'error' },
								{
									databaseId: 101,
									id: 'current-request',
									state: 'CHANGES_REQUESTED',
									author: { __typename: 'Bot', login: APP_IDENTITY.login },
								}
							),
							summaryReview(
								{ ...SUMMARY_MARKER, finished: standing !== 'error' },
								{
									databaseId: 102,
									id: 'previous-request',
									state: 'CHANGES_REQUESTED',
								}
							),
							summaryReview(
								{ ...SUMMARY_MARKER, finished: standing !== 'error' },
								{
									databaseId: 103,
									id: 'current-approval',
									state: 'APPROVED',
									author: { __typename: 'Bot', login: APP_IDENTITY.login },
								}
							)
						)
						if (standing === 'failure') api.threads.push(reviewThread())
						if (denied)
							api.failures.dismissReview.push(
								new GitHubApiError({
									operation: 'dismissReview',
									reason: 'Denied',
									status: 403,
								})
							)
						const previous = {
							id: 1,
							...toCommitStatus(
								standing === 'failure'
									? 'needs fixes'
									: standing === 'error'
										? 'incomplete'
										: 'ready',
								standing === 'failure' ? 1 : 0,
								standing !== 'error'
							),
							context: 'MNG Review',
							creator: null,
						} as const
						const status = githubStatusFake({
							listOpenPullRequests: () =>
								Effect.succeed([openPullRequest(17, 'head')]),
							getStatus: () => Effect.succeed(previous),
						})
						expect(
							yield* StatusSweepService.use(service => service.sweep()).pipe(
								Effect.provide(
									StatusSweepServiceLive.pipe(
										Layer.provide(Layer.merge(api.api, status.layer))
									)
								)
							)
						).toMatchObject({
							checked: 1,
							failed: 0,
							dismissal: {
								dismissed: unbacked && !denied ? 1 : 0,
								failed: unbacked && denied ? 1 : 0,
							},
						})
						expect(
							api.writes.filter(write => write.method === 'dismissReview')
						).toEqual(
							unbacked
								? [
										{
											method: 'dismissReview',
											id: 101,
											body: toClearedMessage('head'),
										},
									]
								: []
						)
						expect(api.reviews[1]?.state).toBe('CHANGES_REQUESTED')
						expect(api.reviews[2]?.state).toBe('APPROVED')
					})
			)
	test.effect(
		'a change request posted while the sweep read the threads is never dismissed',
		() =>
			Effect.gen(function* () {
				const fixture = sweepSetup([toCommitStatus('ready', 0, true)])
				// The change request lands while the sweep reads the threads.
				fixture.api.threadSnapshots.shift = () => {
					fixture.api.reviews.push(fixture.request)
					return undefined
				}
				expect((yield* fixture.sweep).dismissal).toEqual(NO_DISMISSAL)
				expect(fixture.api.reviews[1]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'with no status write due, a status that changed since the read keeps the change request',
		() =>
			Effect.gen(function* () {
				const fixture = sweepSetup([
					toCommitStatus('ready', 0, true),
					toCommitStatus('needs fixes', 1, true),
				])
				fixture.api.reviews.push(fixture.request)
				expect(yield* fixture.sweep).toMatchObject({
					updated: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(fixture.api.reviews[1]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'with no status write due and the status unchanged, the change request is dismissed',
		() =>
			Effect.gen(function* () {
				const fixture = sweepSetup([toCommitStatus('ready', 0, true)])
				fixture.api.reviews.push(fixture.request)
				expect((yield* fixture.sweep).dismissal).toEqual({
					dismissed: 1,
					failed: 0,
				})
				expect(fixture.api.reviews[1]?.state).toBe('DISMISSED')
			})
	)
	test.effect(
		'a status write that fails its freshness check keeps the change request',
		() =>
			Effect.gen(function* () {
				// The previous status is stale, so a write is due; a publish run wrote a newer one meanwhile.
				const fixture = sweepSetup([toCommitStatus('needs fixes', 1, true)])
				fixture.api.reviews.push(fixture.request)
				expect(yield* fixture.sweep).toMatchObject({
					updated: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(fixture.status.statuses).toEqual([])
				expect(fixture.api.reviews[1]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'a change request edited between the read and the dismissal is kept',
		() =>
			Effect.gen(function* () {
				const fixture = sweepSetup([toCommitStatus('ready', 0, true)])
				fixture.api.reviews.push(fixture.request)
				// The sweep's first read sees the request as it was; it is edited before the dismissal.
				fixture.api.reviewSnapshots.push([...fixture.api.reviews])
				fixture.api.reviews[1] = {
					...fixture.request,
					body: `New evidence.\n\n${fixture.request.body}`,
				}
				expect((yield* fixture.sweep).dismissal).toEqual(NO_DISMISSAL)
				expect(
					fixture.api.writes.filter(write => write.method === 'dismissReview')
				).toEqual([])
				expect(fixture.api.reviews[1]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	for (const open of [false, true])
		test.effect(
			`a marker on another head with open=${open} dismisses only change requests off the head`,
			() =>
				Effect.gen(function* () {
					const api = onListedHead(githubApiFake(APP_IDENTITY))
					const author = {
						__typename: 'Bot',
						login: APP_IDENTITY.login,
					} as const
					// An unfinished full run left the marker on the older head.
					const marker = {
						...SUMMARY_MARKER,
						head: 'older-head',
						finished: false,
					}
					api.reviews.push(
						summaryReview(marker, {
							databaseId: 101,
							id: 'older-request',
							state: 'CHANGES_REQUESTED',
							commit: { oid: 'older-head' },
							author,
						}),
						summaryReview(marker, {
							databaseId: 102,
							id: 'head-request',
							state: 'CHANGES_REQUESTED',
							commit: { oid: 'head' },
							author,
						}),
						summaryReview(marker, {
							databaseId: 103,
							id: 'previous-request',
							state: 'CHANGES_REQUESTED',
							commit: { oid: 'older-head' },
						}),
						summaryReview(marker, { databaseId: 104, id: 'summary', author })
					)
					if (open) api.threads.push(reviewThread())
					const previous = {
						id: 1,
						...toCommitStatus(
							open ? 'needs fixes' : 'incomplete',
							open ? 1 : 0,
							false
						),
						context: 'MNG Review',
						creator: null,
					} as const
					const status = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, 'head')]),
						getStatus: () => Effect.succeed(previous),
					})
					expect(
						(yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(api.api, status.layer))
								)
							)
						)).dismissal
					).toEqual(open ? NO_DISMISSAL : { dismissed: 1, failed: 0 })
					expect(
						api.writes
							.filter(write => write.method === 'dismissReview')
							.map(write => write.id)
					).toEqual(open ? [] : [101])
				})
		)
	for (const failureAt of ['second-status-read', 'status-write'] as const)
		test.effect(`sweep dismisses nothing when the ${failureAt} fails`, () =>
			Effect.gen(function* () {
				const api = githubApiFake(APP_IDENTITY)
				api.reviews.push(
					summaryReview(
						{ ...SUMMARY_MARKER, finished: true },
						{
							state: 'CHANGES_REQUESTED',
							author: { __typename: 'Bot', login: APP_IDENTITY.login },
						}
					)
				)
				const failure = new GitHubApiError({
					operation: failureAt,
					reason: 'Denied',
					status: 403,
				})
				const previous = {
					id: 1,
					state: 'failure',
					description: 'stale',
					context: 'MNG Review',
					creator: null,
				} as const
				const getStatusSpy = vi
					.fn()
					.mockReturnValueOnce(Effect.succeed(previous))
					.mockReturnValue(
						failureAt === 'second-status-read'
							? Effect.fail(failure)
							: Effect.succeed(previous)
					)
				const status = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: getStatusSpy,
					setStatus: () =>
						failureAt === 'status-write' ? Effect.fail(failure) : Effect.void,
				})
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(api.api, status.layer))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 0,
					failed: 1,
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(
					api.writes.filter(write => write.method === 'dismissReview')
				).toEqual([])
			})
		)
})

/**
 * A finished pull request on `head` with one change request of the current identity and a stale
 * `failure` status the sweep rewrites to `success`.
 */
function rewriteSetup() {
	const api = onListedHead(githubApiFake(APP_IDENTITY))
	api.reviews.push(
		summaryReview(
			{ ...SUMMARY_MARKER, head: 'head', finished: true },
			{
				databaseId: 101,
				state: 'CHANGES_REQUESTED',
				author: { __typename: 'Bot', login: APP_IDENTITY.login },
			}
		)
	)
	const previous = {
		id: 1,
		state: 'failure',
		description: 'stale',
		context: 'MNG Review',
		creator: null,
	} as const
	const status = githubStatusFake({
		listOpenPullRequests: () => Effect.succeed([openPullRequest(17, 'head')]),
		getStatus: () => Effect.succeed(previous),
	})
	const sweep = StatusSweepService.use(service => service.sweep()).pipe(
		Effect.provide(
			StatusSweepServiceLive.pipe(
				Layer.provide(Layer.merge(api.api, status.layer))
			)
		)
	)
	return { api, status, sweep }
}

layer(APP_MODE_OWNED)('StatusSweepService reads before dismissals', test => {
	test.effect(
		'a review re-read that fails after the status update counts as failed and keeps the update',
		() =>
			Effect.gen(function* () {
				const fixture = rewriteSetup()
				fixture.api.failures.listReviews.push(
					undefined,
					new GitHubApiError({
						operation: 'listReviews',
						reason: 'Denied',
						status: 403,
					})
				)
				expect(yield* fixture.sweep).toEqual({
					checked: 1,
					updated: 1,
					failed: 1,
					dismissal: NO_DISMISSAL,
				})
				expect(fixture.status.statuses).toHaveLength(1)
				expect(fixture.api.reviews[0]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'a head re-read that fails after the status update counts as failed and keeps the update',
		() =>
			Effect.gen(function* () {
				const fixture = rewriteSetup()
				fixture.api.failures.getPullRequest.push(
					new GitHubApiError({
						operation: 'getPullRequest',
						reason: 'Unavailable',
						status: 503,
					})
				)
				expect(yield* fixture.sweep).toEqual({
					checked: 1,
					updated: 1,
					failed: 1,
					dismissal: NO_DISMISSAL,
				})
				expect(fixture.api.reviews[0]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'a push after the listing keeps the change request the sweep judged unbacked',
		() =>
			Effect.gen(function* () {
				const fixture = rewriteSetup()
				onListedHead(fixture.api, 'next-head')
				expect(yield* fixture.sweep).toEqual({
					checked: 1,
					updated: 1,
					failed: 0,
					dismissal: NO_DISMISSAL,
				})
				expect(
					fixture.api.writes.filter(write => write.method === 'dismissReview')
				).toEqual([])
				expect(fixture.api.reads).toContain('getPullRequest:17')
			})
	)
	test.effect(
		'with no status write due, a status re-read that fails counts the pull request as failed',
		() =>
			Effect.gen(function* () {
				const fixture = sweepSetup([toCommitStatus('ready', 0, true)])
				fixture.api.reviews.push(fixture.request)
				const status = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: vi
						.fn()
						.mockReturnValueOnce(
							Effect.succeed({
								id: 1,
								...toCommitStatus('ready', 0, true),
								context: 'MNG Review',
								creator: null,
							})
						)
						.mockReturnValue(
							Effect.fail(
								new GitHubApiError({
									operation: 'getStatus',
									reason: 'Denied',
									status: 403,
								})
							)
						),
				})
				expect(
					yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fixture.api.api, status.layer))
							)
						)
					)
				).toEqual({
					checked: 1,
					updated: 0,
					failed: 1,
					dismissal: NO_DISMISSAL,
				})
				expect(fixture.api.writes).toEqual([])
				expect(fixture.api.reviews[1]?.state).toBe('CHANGES_REQUESTED')
			})
	)
	test.effect(
		'a marker on another head keeps a change request whose commit is unknown',
		() =>
			Effect.gen(function* () {
				const api = onListedHead(githubApiFake(APP_IDENTITY))
				const author = { __typename: 'Bot', login: APP_IDENTITY.login } as const
				const marker = {
					...SUMMARY_MARKER,
					head: 'older-head',
					finished: false,
				}
				api.reviews.push(
					summaryReview(marker, {
						databaseId: 101,
						id: 'lost-commit-request',
						state: 'CHANGES_REQUESTED',
						commit: null,
						author,
					}),
					summaryReview(marker, {
						databaseId: 102,
						id: 'older-request',
						state: 'CHANGES_REQUESTED',
						commit: { oid: 'older-head' },
						author,
					}),
					summaryReview(marker, { databaseId: 103, id: 'summary', author })
				)
				const previous = {
					id: 1,
					...toCommitStatus('incomplete', 0, false),
					context: 'MNG Review',
					creator: null,
				} as const
				const status = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: () => Effect.succeed(previous),
				})
				expect(
					(yield* StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(api.api, status.layer))
							)
						)
					)).dismissal
				).toEqual({ dismissed: 1, failed: 0 })
				expect(
					api.writes
						.filter(write => write.method === 'dismissReview')
						.map(write => write.id)
				).toEqual([102])
				expect(api.reviews[0]?.state).toBe('CHANGES_REQUESTED')
			})
	)
})
