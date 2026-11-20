import { layer } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	makeGitHubHttp,
	getGitHubRequestBody,
	GITHUB_SETTINGS,
} from '../../../shared/mocks/github-http.helper'
import { githubStatusFake } from '../../../shared/mocks/github-status-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	appSummary,
	reviewThread,
	botClosedReviewThread,
	bug,
	SUMMARY_MARKER,
	TOKEN_MODE_OWNED,
} from '../../../shared/mocks/publish-test.helper'
import {
	SummaryCommentService,
	SummaryCommentServiceLive,
} from '../../publish/application/summary-comment.service'
import { parseSummaryMarker } from '../../publish/domain/publish-marker.parser'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import { toCommitStatus, UNFINISHED_NOTE } from '../domain/status.helper'
import {
	StatusSweepService,
	StatusSweepServiceLive,
} from './status-sweep.service'

layer(TOKEN_MODE_OWNED)('StatusSweepService', test => {
	test.effect(
		'heads without a bot status are skipped without reading their threads',
		() =>
			Effect.gen(function* () {
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([{ number: 1, head: { sha: 'unknown' } }]),
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
								Layer.provide(Layer.merge(fake.layer, apiLayer))
							)
						)
					)
				).toEqual({ checked: 0, updated: 0, failed: 0 })
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
						Effect.succeed([{ number: 1, head: { sha: 'head' } }]),
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
				).toEqual({ checked: 1, updated: 1, failed: 0 })
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
								{ number: 1, head: { sha: 'first' } },
								{ number: 2, head: { sha: 'second' } },
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
					).toEqual({ checked: 2, updated: 1, failed: 1 })
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
							Effect.succeed([{ number: 17, head: { sha: 'head' } }]),
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
						Effect.succeed([{ number: 17, head: { sha: 'head' } }]),
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
				).toEqual({ checked: 1, updated: 1, failed: 0 })
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
				api.comments.push({
					id: 'summary-node',
					databaseId: 101,
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
						Effect.succeed([{ number: 17, head: { sha: 'head' } }]),
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
				).toEqual({ checked: 1, updated: 1, failed: 0 })
				expect(fake.statuses).toEqual([
					{
						sha: 'head',
						...toCommitStatus(
							scenario.expected > 0 ? 'needs fixes' : 'ready',
							scenario.expected,
							true
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
						api.comments.push({
							id: 'summary-node',
							databaseId: 101,
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
								Effect.succeed([{ number: 17, head: { sha: 'head' } }]),
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
						})
						expect(fake.statuses).toEqual([{ sha: 'head', ...repaired }])
						expect(yield* sweeper.sweep()).toEqual({
							checked: 1,
							updated: 0,
							failed: 0,
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
						Effect.succeed([{ number: 17, head: { sha: 'head' } }]),
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
				).toEqual({ checked: 1, updated: 0, failed: 0 })
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
									? [{ number: 17, head: { sha: 'head' } }]
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
				).toEqual({ checked: 1, updated: 1, failed: 0 })
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
					const summaryLayer = SummaryCommentServiceLive.pipe(
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
						yield* SummaryCommentService.use(service =>
							service.publishStatus({
								pullNumber: 17,
								head: 'new-head',
								engineCommit: undefined,
								status: 'offline',
							})
						).pipe(Effect.provide(summaryLayer))
					).toBe(true)
					expect(
						parseSummaryMarker(
							api.comments.find(
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
							Effect.succeed([{ number: 17, head: { sha: 'new-head' } }]),
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
					).toEqual({ checked: 1, updated: 0, failed: 0 })
					expect(statuses.statuses).toEqual([])
					expect(statuses.statuses.at(-1)?.state ?? previous.state).toBe(
						'error'
					)
					expect(api.writes.map(write => write.method)).toEqual([
						'create',
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
						Effect.succeed([{ number: 17, head: { sha: 'head' } }]),
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
				).toEqual({ checked: 1, updated: 1, failed: 0 })
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
									Effect.succeed([{ number: 17, head: { sha: 'head' } }]),
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
							).toEqual({ checked: 1, updated: hidden ? 1 : 0, failed: 0 })
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
