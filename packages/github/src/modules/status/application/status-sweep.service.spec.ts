import { layer } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { RECENT_COMMENTS } from '../../../platform/github-api.constants'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { provideListCompleteness } from '../../../platform/list-completeness.context'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	makeGitHubHttp,
	getGitHubRequestBody,
	GITHUB_SETTINGS,
	readThreadOverHttp,
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
	unsettledBugThread,
} from '../../../shared/mocks/thread-reply-test.helper'
import {
	SummaryReviewService,
	SummaryReviewServiceLive,
} from '../../publish/application/summary-review.service'
import {
	parseReplyMarker,
	parseSummaryMarker,
} from '../../publish/domain/publish-marker.parser'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import {
	type CommitStatusText,
	toCommitStatus,
	INCOMPLETE_STATUS,
	toLoweredStatus,
	UNFINISHED_NOTE,
} from '../domain/status.helper'
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
				// A green head: the sweep lowers it for what blocks and leaves it for what does not.
				const fake = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(1, 'head')]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							...toCommitStatus('ready', 0, true),
							context: 'MNG Review',
							creator: { login: 'github-actions[bot]', type: 'Bot' },
						}),
				})
				const blocks = kind === 'open' || kind === 'human-after-bot'
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
					updated: blocks ? 1 : 0,
					failed: 0,
				})
				expect(fake.statuses).toEqual(
					blocks
						? [{ sha: 'head', ...toCommitStatus('needs fixes', 1, true) }]
						: []
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
					// An open bug thread, so the sweep lowers each green head to `failure`.
					api.threads.push(reviewThread())
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
										...toCommitStatus('ready', 0, true),
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
					})
					expect(fake.statuses).toContainEqual(
						expect.objectContaining({ sha: 'second', state: 'failure' })
					)
				})
		)
})

layer(TOKEN_MODE_OWNED)('StatusSweepService latest status', test => {
	for (const latest of ['same', 'newer', 'gone', 'read-failed'] as const)
		test.effect(
			`a ${latest} status at the read before the write controls the write`,
			() =>
				Effect.gen(function* () {
					const previous = {
						id: 1,
						...toCommitStatus('ready', 0, true),
						context: 'MNG Review',
						creator: null,
					}
					// The sweep's read, then the read right before the write.
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
					// An open bug thread lowers the green head.
					api.threads.push(reviewThread())
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
							? [{ sha: 'head', ...toCommitStatus('needs fixes', 1, true) }]
							: []
					)
				})
		)
	test.effect(
		'resolving the last bug from an unfinished run leaves the failure, never success',
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
					updated: 0,
					failed: 0,
				})
				// `error` blocks no more than `failure`, so the sweep leaves it for a run.
				expect(fake.statuses).toEqual([])
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
				// A green head: the sweep lowers it for the bugs it counts, or for a run off the head.
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
				const lowers = scenario.expected > 0 || scenario.head !== 'head'
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
					updated: lowers ? 1 : 0,
					failed: 0,
				})
				expect(fake.statuses).toEqual(
					lowers
						? [
								{
									sha: 'head',
									...toCommitStatus(
										scenario.expected > 0 ? 'needs fixes' : 'ready',
										scenario.expected,
										scenario.head === 'head'
									),
								},
							]
						: []
				)
				expect(api.writes).toEqual([])
			})
		)
	for (const finished of [true, false])
		for (const edited of [true, false])
			test.effect(
				`${edited ? 'bot-edited' : 'unedited'} summary with finished=${finished} ${finished ? 'leaves an overwritten error to the raise job' : 'lowers an overwritten success'}`,
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
						// The read, and the read before the write when the sweep lowers.
						const reads = finished ? 1 : 2
						const getStatusSpy = vi.fn((_sha: string) =>
							Effect.succeed(
								getStatusSpy.mock.calls.length <= reads
									? previous
									: { ...previous, ...repaired, id: 2 }
							)
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
							updated: finished ? 0 : 1,
							failed: 0,
						})
						// Only a lowering is the sweep's: the `success` waits for the raise job.
						expect(fake.statuses).toEqual(
							finished ? [] : [{ sha: 'head', ...repaired }]
						)
						expect(yield* sweeper.sweep()).toEqual({
							checked: 1,
							updated: 0,
							failed: 0,
						})
						expect(getStatusSpy.mock.calls).toEqual(
							Array.from({ length: reads + 1 }, () => ['head'])
						)
						expect(fake.statuses).toHaveLength(finished ? 0 : 1)
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
				// A green head the sweep lowers for the owned threads and the summary's bugs.
				const previous = {
					id: 1,
					...toCommitStatus('ready', 0, true),
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
				const state =
					scenario.own || !scenario.previousFinished ? 'success' : 'error'
				const expected = toCommitStatus('ready', 0, scenario.expectedFinished)
				const lowers =
					toLoweredStatus([expected], { state, description: 'stale' }) !==
					undefined
				const statuses = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: () =>
						Effect.succeed({
							id: 1,
							state,
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
					updated: lowers ? 1 : 0,
					failed: 0,
				})
				// The sweep writes the judged status only where it lowers; a raise is the locked job's.
				expect(statuses.statuses).toEqual(
					lowers ? [{ sha: 'head', ...expected }] : []
				)
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
					`${hidden && state === 'success' ? 'lowers' : 'keeps'} ${state} while a current identity duplicate is ${hidden ? 'hidden' : 'visible'}`,
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
							// Hidden, the duplicate leaves one summary: an unfinished one lowers a `success` to
							// `error`, and a finished one would raise, which is the locked job's.
							const lowers = hidden && state === 'success'
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
								updated: lowers ? 1 : 0,
								failed: 0,
							})
							expect(statuses.statuses).toEqual(
								lowers
									? [{ sha: 'head', ...toCommitStatus('ready', 0, finished) }]
									: []
							)
							// A lowering reads the status again right before it writes.
							expect(getStatusSpy).toHaveBeenCalledTimes(lowers ? 2 : 1)
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
						// A green head, so every judgment here lowers it and shows in the write.
						const previous = {
							id: 1,
							...toCommitStatus('ready', 0, true),
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
							updated: 1,
							failed: 0,
						})
						expect(fake.statuses).toEqual([
							{
								sha: 'head',
								...(markerHead === 'head'
									? toCommitStatus('needs fixes', 2 + threadBugs, true)
									: toCommitStatus(
											threadBugs ? 'needs fixes' : 'incomplete',
											threadBugs,
											false
										)),
							},
						])
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
						// A green head: a wait no owner cleared lowers it, a cleared one leaves it.
						getStatus: () =>
							Effect.succeed({
								id: 1,
								...toCommitStatus('ready', 0, true),
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
						updated: cleared ? 0 : 1,
						failed: 0,
					})
					expect(fake.statuses).toEqual(
						cleared
							? []
							: [
									{
										sha: SUMMARY_MARKER.head,
										...toCommitStatus('needs owner', 0, true),
									},
								]
					)
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
				`${scenario} lowers for a writer and stays clear for an owner: ${resolver}`,
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
						// A green head: a wait no owner cleared lowers it, a cleared one leaves it.
						const previous = {
							id: 1,
							...toCommitStatus('ready', 0, true),
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
						const lowers = resolver === 'writer'
						expect(yield* sweeper.sweep(allow)).toEqual({
							checked: 1,
							updated: lowers ? 1 : 0,
							failed: 0,
						})
						expect(statuses.statuses).toEqual(
							lowers
								? [{ sha: 'head', ...toCommitStatus('needs owner', 0, true) }]
								: []
						)
						expect(yield* sweeper.sweep(allow)).toEqual({
							checked: 1,
							updated: 0,
							failed: 0,
						})
						expect(statuses.statuses).toHaveLength(lowers ? 1 : 0)
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
					`an edited root resolved by ${resolver} ${listed ? 'with' : 'without'} a summary waiting id ${resolver === 'writer' && initialState === 'success' ? 'lowers' : 'leaves'} ${initialState}`,
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
							const lowers = resolver === 'writer' && initialState === 'success'
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
								updated: lowers ? 1 : 0,
								failed: 0,
							})
							// A writer's resolve keeps the wait, which lowers a `success`; an owner's clears it,
							// and turning the head green is the locked job's.
							expect(statuses.statuses).toEqual(
								lowers
									? [{ sha: 'head', ...toCommitStatus('needs owner', 0, true) }]
									: []
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

/**
 * An open pull request on `head` whose own summary marks it finished, and its status: read `n` gives
 * `statuses[n - 1]`, then the last one, each entry under an id of its own as a new status would be.
 */
function sweepSetup(statuses: readonly CommitStatusText[]) {
	const api = onListedHead(githubApiFake(APP_IDENTITY))
	const author = { __typename: 'Bot', login: APP_IDENTITY.login } as const
	api.reviews.push(
		summaryReview(
			{ ...SUMMARY_MARKER, head: 'head', finished: true },
			{ databaseId: 101, author }
		)
	)
	const getStatusSpy = vi.fn((_sha: string) => {
		const index = Math.min(getStatusSpy.mock.calls.length, statuses.length)
		return Effect.succeed({
			id: Math.max(index, 1),
			...(statuses[index - 1] ?? toCommitStatus('ready', 0, true)),
			context: 'MNG Review',
			creator: null,
		})
	})
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

layer(TOKEN_MODE_OWNED)('StatusSweepService unsettled bug threads', test => {
	for (const [place, readFails] of [
		['window', false],
		['outside', false],
		['outside', true],
		['outside', 'null node'],
	] as const)
		test.effect(
			`a resolved bug with its unsettled answer ${place} the window is open, read fails=${readFails}`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake()
					const { thread, comments } = unsettledBugThread(place)
					api.threads.push(thread)
					api.threadComments.set(thread.id, [...comments])
					if (readFails === true)
						api.failures.listThreadComments.push(
							new GitHubApiError({
								operation: 'listThreadComments',
								reason: 'unavailable',
								status: 503,
							})
						)
					if (readFails === 'null node')
						api.threadReader.read = readThreadOverHttp(
							comments.map(comment =>
								parseReplyMarker(comment.body)?.unsettled ? null : comment
							)
						)
					const fake = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(1, 'head')]),
						getStatus: () =>
							Effect.succeed({
								id: 1,
								state: 'success',
								description: 'stale',
								context: 'MNG Review',
								creator: { login: 'github-actions[bot]', type: 'Bot' },
							}),
					})
					const swept = yield* StatusSweepService.use(service =>
						service.sweep()
					).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fake.layer, api.api))
							)
						)
					)
					// A whole thread GitHub keeps listing a null node in fails the pull request.
					if (readFails === 'null node') {
						expect(swept).toMatchObject({ updated: 0, failed: 1 })
						expect(fake.statuses).toEqual([])
					} else
						expect(fake.statuses).toEqual([
							expect.objectContaining({ sha: 'head', state: 'failure' }),
						])
					expect(api.writes).toEqual([])
				})
		)
})

layer(APP_MODE_OWNED)('StatusSweepService incomplete list reads', test => {
	test.effect(
		'a sweep whose only open bug thread GitHub listed as null holds a success as pending, a complete one lowers it to failure',
		() =>
			Effect.gen(function* () {
				const fixture = sweepSetup([])
				// The head stands `success`; a bug thread opened since, which GitHub lists as a null node.
				const status = newestStatus(toCommitStatus('ready', 0, true))
				fixture.api.nullNodes.threads = 1
				const sweep = StatusSweepService.use(service => service.sweep()).pipe(
					Effect.provide(
						StatusSweepServiceLive.pipe(
							Layer.provide(Layer.merge(fixture.api.api, status.layer))
						)
					),
					provideListCompleteness(false)
				)
				expect(yield* sweep).toMatchObject({ checked: 1, updated: 1 })
				expect(status.statuses).toEqual([{ sha: 'head', ...INCOMPLETE_STATUS }])
				// GitHub lists the thread again.
				fixture.api.nullNodes.threads = 0
				fixture.api.threads.push(reviewThread())
				expect(yield* sweep).toMatchObject({ checked: 1, updated: 1 })
				expect(status.statuses.at(-1)).toEqual({
					sha: 'head',
					...toCommitStatus('needs fixes', 1, true),
				})
			})
	)
	test.effect(
		'an incomplete sweep turns a success into pending, and a complete one leaves the success to the locked job',
		() =>
			Effect.gen(function* () {
				const fixture = sweepSetup([])
				// The head's status is the newest one written, `success` before the first sweep.
				const status = githubStatusFake({
					listOpenPullRequests: () =>
						Effect.succeed([openPullRequest(17, 'head')]),
					getStatus: () =>
						Effect.succeed({
							id: status.statuses.length,
							...toCommitStatus('ready', 0, true),
							...status.statuses.at(-1),
							context: 'MNG Review',
							creator: null,
						}),
				})
				fixture.api.nullNodes.threads = 1
				const sweep = StatusSweepService.use(service => service.sweep()).pipe(
					Effect.provide(
						StatusSweepServiceLive.pipe(
							Layer.provide(Layer.merge(fixture.api.api, status.layer))
						)
					),
					provideListCompleteness(false)
				)
				expect(yield* sweep).toMatchObject({ checked: 1, updated: 1 })
				expect(status.statuses).toEqual([{ sha: 'head', ...INCOMPLETE_STATUS }])
				expect(yield* sweep).toMatchObject({ checked: 1, updated: 0 })
				fixture.api.nullNodes.threads = 0
				expect(yield* sweep).toMatchObject({ checked: 1, updated: 0 })
				expect(status.statuses).toHaveLength(1)
			})
	)
	test.effect(
		'an incomplete sweep beside two current identity summaries turns a success into pending',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake(APP_IDENTITY)
				api.comments.push(
					appSummary({ ...SUMMARY_MARKER, head: 'head', finished: true }),
					appSummary(
						{ ...SUMMARY_MARKER, head: 'head', finished: true },
						{ id: 'newer-summary', databaseId: 102 }
					)
				)
				const status = newestStatus(toCommitStatus('ready', 0, true))
				api.nullNodes.threads = 1
				const sweep = StatusSweepService.use(service => service.sweep()).pipe(
					Effect.provide(
						StatusSweepServiceLive.pipe(
							Layer.provide(Layer.merge(api.api, status.layer))
						)
					),
					provideListCompleteness(false)
				)
				expect(yield* sweep).toEqual({
					checked: 1,
					updated: 1,
					failed: 0,
					incomplete: [{ pullNumber: 17, lists: ['review threads'] }],
				})
				expect(status.statuses).toEqual([{ sha: 'head', ...INCOMPLETE_STATUS }])
				expect(api.writes).toEqual([])
				// A complete sweep leaves the duplicates' status as it is again.
				api.nullNodes.threads = 0
				expect(yield* sweep).toMatchObject({ checked: 1, updated: 0 })
				expect(status.statuses).toHaveLength(1)
			})
	)
})

/** A status fake for pull request 17 whose head shows the newest status written, `first` before any. */
function newestStatus(first: CommitStatusText) {
	const status = githubStatusFake({
		listOpenPullRequests: () => Effect.succeed([openPullRequest(17, 'head')]),
		getStatus: () =>
			Effect.succeed({
				id: status.statuses.length,
				...first,
				...status.statuses.at(-1),
				context: 'MNG Review',
				creator: null,
			}),
	})
	return status
}

/** A summary review of the app on `head` that an incomplete write left unfinished and failed. */
function unfinishedSummary(databaseId: number) {
	return summaryReview(
		{ ...SUMMARY_MARKER, head: 'head', finished: false, failed: true },
		{
			id: `unfinished-${databaseId}`,
			databaseId,
			author: { __typename: 'Bot', login: APP_IDENTITY.login },
		}
	)
}

layer(APP_MODE_OWNED)('StatusSweepService unfinished summaries', test => {
	for (const standing of ['failure', 'success'] as const)
		test.effect(
			`a complete sweep over an unfinished summary with nothing open leaves a ${standing} as it may`,
			() =>
				Effect.gen(function* () {
					const fixture = sweepSetup([])
					fixture.api.reviews.push(unfinishedSummary(103))
					const status = newestStatus(
						standing === 'success'
							? toCommitStatus('ready', 0, true)
							: toCommitStatus('needs fixes', 1, true)
					)
					const sweep = StatusSweepService.use(service => service.sweep()).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(fixture.api.api, status.layer))
							)
						)
					)
					expect(yield* sweep).toMatchObject({
						checked: 1,
						failed: 0,
					})
					// The marker may miss what set the `failure`, so `error` never replaces it.
					expect(status.statuses).toEqual(
						standing === 'success'
							? [{ sha: 'head', ...toCommitStatus('ready', 0, false) }]
							: []
					)
				})
		)
})
