import { layer } from '@effect/vitest'
import { RulesService } from '@mng-review/engine'
import {
	GitHubApiError,
	GitHubConfig,
	GitHubReadConfigLive,
	MAX_REPLY_THREADS,
	ReplyFindService,
} from '@mng-review/github'
import { ConfigProvider, Effect, FileSystem, Layer } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires these existing unexported GitHub fixtures.
import {
	appSummary,
	reviewThread,
	SUMMARY_MARKER,
} from '../../../../../packages/github/src/shared/mocks/publish-test.helper'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires shared GitHub reply fixtures.
import {
	pendingReply,
	pendingReviewThread,
} from '../../../../../packages/github/src/shared/mocks/thread-reply-test.helper'
import { PrepareRunServiceLive } from '../../application/prepare-run.service'
import { parsePreparedRun } from '../../infrastructure/prepared-run.parser'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { runPrepareStep } from './prepare-step.handler'

afterEach(() => {
	cleanupRepos()
})

layer(FileSystemLayer)('prepare step', test => {
	test.effect(
		'GitHub read errors still write ready without prior runs or threads',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const fs = yield* FileSystem.FileSystem
				const error = new GitHubApiError({
					operation: 'read',
					reason: 'unavailable',
					status: 503,
				})
				fixture.api.failures.listThreads.push(error)
				fixture.api.failures.listComments.push(error)
				yield* runPrepareStep.pipe(
					Effect.provide(
						PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer())
				)
				expect(
					yield* parsePreparedRun(
						yield* fs.readFileString(fixture.paths.prepared)
					)
				).toMatchObject({ status: 'ready', threads: [] })
				const text = yield* fs.readFileString(fixture.paths.prepared)
				expect(JSON.parse(text)).not.toHaveProperty('prior')
				expect(JSON.parse(text)).not.toHaveProperty('rules')
				expect(yield* fs.readFileString(fixture.paths.output)).toBe(
					'ready=true\n'
				)
				expect(fixture.api.writes).toEqual([])
			})
	)
	test.effect(
		'serializes only bot-owned unedited threads with valid markers',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const bot = reviewThread()
				fixture.api.threads.push(
					{ ...bot, id: 'owned' },
					{
						...bot,
						id: 'human',
						comments: {
							totalCount: 1,
							nodes: bot.comments.nodes.map(comment => ({
								...comment,
								author: { __typename: 'User', login: 'contributor' },
							})),
						},
					},
					{
						...bot,
						id: 'edited',
						comments: {
							totalCount: 1,
							nodes: bot.comments.nodes.map(comment => ({
								...comment,
								editor: { __typename: 'User', login: 'contributor' },
							})),
						},
					},
					{
						...bot,
						id: 'broken',
						comments: {
							totalCount: 1,
							nodes: bot.comments.nodes.map(comment => ({
								...comment,
								body: 'ordinary comment',
							})),
						},
					}
				)
				yield* runPrepareStep.pipe(
					Effect.provide(
						PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer())
				)
				const fs = yield* FileSystem.FileSystem
				const prepared = yield* parsePreparedRun(
					yield* fs.readFileString(fixture.paths.prepared)
				)
				expect(prepared.status).toBe('ready')
				if (prepared.status === 'ready')
					expect(prepared.threads.map(thread => thread.id)).toEqual(['owned'])
				expect(fixture.api.writes).toEqual([])
			})
	)
})

layer(Layer.empty)('prepare configuration', test => {
	for (const token of [undefined, '', '   '])
		test.effect(`requires GITHUB_TOKEN when ${JSON.stringify(token)}`, () =>
			Effect.gen(function* () {
				expect(
					yield* GitHubConfig.pipe(
						Effect.provide(GitHubReadConfigLive),
						Effect.provide(
							ConfigProvider.layer(
								ConfigProvider.fromEnvRecord({
									GITHUB_REPOSITORY: 'example/project',
									...(token === undefined ? {} : { GITHUB_TOKEN: token }),
								})
							)
						),
						Effect.flip
					)
				).toMatchObject({ _tag: 'ConfigError', source: 'GITHUB_TOKEN' })
			})
		)
})

layer(FileSystemLayer)('prepare app identity from base rules', test => {
	for (const previous of [[], ['github-actions']])
		test.effect(
			`base identity.previous=${previous.join(',')} controls prior summary and threads`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture(previous, true, true)
					fixture.repo.write(
						'.mng/review.yml',
						`identity: {previous: ${previous.length ? '[]' : '[github-actions]'}}`
					)
					fixture.repo.commit()
					fixture.api.threads.push(reviewThread())
					fixture.api.comments.push(
						appSummary(
							{ ...SUMMARY_MARKER, runs: 3, head: 'earlier-head' },
							{ author: { __typename: 'Bot', login: 'github-actions' } }
						)
					)
					yield* runPrepareStep.pipe(
						Effect.provide(
							PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
						),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(fixture.envLayer())
					)
					const prepared = yield* parsePreparedRun(
						yield* (yield* FileSystem.FileSystem).readFileString(
							fixture.paths.prepared
						)
					)
					expect(fixture.loads).toEqual([fixture.base])
					expect(prepared.status).toBe('ready')
					if (prepared.status !== 'ready') return
					expect(prepared.threads).toHaveLength(previous.length ? 1 : 0)
					expect(prepared.prior).toEqual(
						previous.length ? { runs: 3, head: 'earlier-head' } : undefined
					)
					expect(fixture.api.writes).toEqual([])
				})
		)
})

layer(FileSystemLayer)('prepare command target', test => {
	for (const moved of [true, false])
		test.effect(
			`reads the pull request again and moved=${moved} controls readiness beyond the push cap`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const pr = fixture.api.command.pullRequest
					fixture.api.command.pullRequest = {
						...pr,
						base: { ...pr.base, sha: fixture.base },
						head: { ...pr.head, sha: moved ? 'c'.repeat(40) : fixture.head },
					}
					fixture.api.comments.push(
						appSummary(
							{
								...SUMMARY_MARKER,
								runs: fixture.rules.config.limits.max_runs_per_pr,
								head: fixture.base,
							},
							{ author: { __typename: 'Bot', login: 'github-actions' } }
						)
					)
					yield* runPrepareStep.pipe(
						Effect.provide(
							PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
						),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(
							fixture.envLayer({
								GITHUB_EVENT_NAME: 'issue_comment',
								GITHUB_EVENT_PATH: `${fixture.repo.root}/missing.json`,
								MNG_REVIEW_TRIGGER: 'command',
								MNG_REVIEW_TARGET_PR: '17',
								MNG_REVIEW_TARGET_BASE: fixture.base,
								MNG_REVIEW_TARGET_HEAD: fixture.head,
								MNG_REVIEW_COMMAND_DEPTH: 'quick',
							})
						)
					)
					const fs = yield* FileSystem.FileSystem
					const prepared = yield* parsePreparedRun(
						yield* fs.readFileString(fixture.paths.prepared)
					)
					expect(prepared).toMatchObject(
						moved
							? {
									status: 'skipped',
									reason:
										'the pull request has a new head since the command; comment again to review it',
								}
							: {
									status: 'ready',
									event: {
										number: 17,
										baseSha: fixture.base,
										headSha: fixture.head,
										pr: { trigger: 'manual', depth: 'quick' },
									},
									prior: { runs: fixture.rules.config.limits.max_runs_per_pr },
								}
					)
					expect(yield* fs.readFileString(fixture.paths.output)).toBe(
						`ready=${!moved}\n`
					)
					expect(fixture.api.reads).toEqual(['getPullRequest:17'])
					expect(fixture.loads).toEqual(moved ? [] : [fixture.base])
					expect(fixture.api.writes).toEqual([])
				})
		)
})

layer(FileSystemLayer)('prepare author replies', test => {
	for (const failure of [
		undefined,
		'getCollaboratorRole',
		'listThreadComments',
	] as const)
		test.effect(`writes prepared replies, GitHub failure=${failure}`, () =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const fs = yield* FileSystem.FileSystem
				fixture.api.command.role = 'write'
				fixture.api.threads.push(pendingReviewThread())
				if (failure)
					fixture.api.failures[failure].push(
						new GitHubApiError({
							operation: failure,
							reason: 'unavailable',
							status: 503,
						})
					)
				yield* runPrepareStep.pipe(
					Effect.provide(
						PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer())
				)
				const prepared = yield* parsePreparedRun(
					yield* fs.readFileString(fixture.paths.prepared)
				)
				expect(prepared.status).toBe('ready')
				if (prepared.status === 'ready')
					expect(prepared.replies ?? []).toEqual(
						failure ? [] : [pendingReply()]
					)
				expect(fixture.api.writes).toEqual([])
			})
		)
})

layer(FileSystemLayer)('prepare owner waiting', test => {
	test.effect(
		'carries marker waiting ids and omits their replies from the prepared file',
		() =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				fixture.api.command.role = 'write'
				fixture.api.threads.push(
					pendingReviewThread(),
					pendingReviewThread({ id: 'active-thread' })
				)
				fixture.api.comments.push(
					appSummary(
						{
							...SUMMARY_MARKER,
							head: fixture.base,
							needsOwner: ['thread'],
						},
						{ author: { __typename: 'Bot', login: 'github-actions' } }
					)
				)
				yield* runPrepareStep.pipe(
					Effect.provide(
						PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(fixture.envLayer())
				)
				const fs = yield* FileSystem.FileSystem
				const prepared = yield* parsePreparedRun(
					yield* fs.readFileString(fixture.paths.prepared)
				)
				expect(prepared.status).toBe('ready')
				if (prepared.status !== 'ready') return
				expect(prepared.prior?.waiting).toEqual(['thread'])
				expect(prepared.replies).toEqual([
					pendingReply({ threadId: 'active-thread' }),
				])
				expect(fixture.api.reads).not.toContain('listThreadComments:thread')
				expect(fixture.api.writes).toEqual([])
			})
	)
})

layer(FileSystemLayer)('prepare converse target', test => {
	for (const scenario of [
		'moved',
		'new base',
		'skip label',
		'draft',
		'closed',
		'fork',
		'no reply',
	] as const)
		test.effect(`converse preparation handles ${scenario}`, () =>
			Effect.gen(function* () {
				const fixture = stepFixture()
				const pr = fixture.api.command.pullRequest
				fixture.api.command.pullRequest = {
					...pr,
					state: scenario === 'closed' ? 'closed' : 'open',
					draft: scenario === 'draft',
					labels: [
						{ name: fixture.rules.config.skip.labels[0] ?? 'skip-review' },
					],
					base: {
						...pr.base,
						sha: scenario === 'new base' ? 'd'.repeat(40) : fixture.base,
					},
					head: {
						...pr.head,
						sha: scenario === 'moved' ? 'c'.repeat(40) : fixture.head,
						repo: {
							full_name:
								scenario === 'fork' ? 'example/fork' : pr.base.repo.full_name,
						},
					},
				}
				fixture.api.command.role = 'write'
				if (scenario !== 'no reply')
					fixture.api.threads.push(pendingReviewThread())
				fixture.api.comments.push(
					appSummary(
						{
							...SUMMARY_MARKER,
							head: fixture.base,
							runs: fixture.rules.config.limits.max_runs_per_pr,
							manualRuns: fixture.rules.config.commands.max_runs,
						},
						{ author: { __typename: 'Bot', login: 'github-actions' } }
					)
				)
				yield* runPrepareStep.pipe(
					Effect.provide(
						PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
					),
					Effect.provide(fixture.publisherLayer),
					Effect.provide(
						fixture.envLayer({
							GITHUB_EVENT_NAME: 'schedule',
							MNG_REVIEW_TRIGGER: 'converse',
							MNG_REVIEW_TARGET_PR: '17',
							MNG_REVIEW_TARGET_BASE: fixture.base,
							MNG_REVIEW_TARGET_HEAD: fixture.head,
						})
					)
				)
				const fs = yield* FileSystem.FileSystem
				const prepared = yield* parsePreparedRun(
					yield* fs.readFileString(fixture.paths.prepared)
				)
				expect(prepared.status).toBe(
					scenario === 'skip label' ? 'ready' : 'skipped'
				)
				if (scenario === 'new base')
					expect(prepared).toMatchObject({
						status: 'skipped',
						reason:
							'the pull request has a new base since the schedule listed it; the next run reads it again',
					})
				if (prepared.status === 'ready') {
					expect(prepared.replies).toEqual([pendingReply()])
					expect(prepared.prior?.runs).toBe(
						fixture.rules.config.limits.max_runs_per_pr
					)
				}
				expect(yield* fs.readFileString(fixture.paths.output)).toBe(
					`ready=${scenario === 'skip label'}\n`
				)
				expect(fixture.api.reads).toContain('getPullRequest:17')
				expect(fixture.api.writes).toEqual([])
			})
		)
	for (const rotation of [0, 1])
		test.effect(
			`uses schedule run number ${rotation} to rotate pending threads`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture()
					const pr = fixture.api.command.pullRequest
					fixture.api.command.pullRequest = {
						...pr,
						base: { ...pr.base, sha: fixture.base },
						head: { ...pr.head, sha: fixture.head },
					}
					fixture.api.command.role = 'write'
					fixture.api.threads.push(
						...Array.from({ length: MAX_REPLY_THREADS + 1 }, (_, index) =>
							pendingReviewThread({ id: `thread-${index}` })
						)
					)
					yield* runPrepareStep.pipe(
						Effect.provide(
							PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
						),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(
							fixture.envLayer({
								GITHUB_EVENT_NAME: 'schedule',
								MNG_REVIEW_TRIGGER: 'converse',
								MNG_REVIEW_TARGET_PR: '17',
								MNG_REVIEW_TARGET_BASE: fixture.base,
								MNG_REVIEW_TARGET_HEAD: fixture.head,
								...(rotation ? { GITHUB_RUN_NUMBER: String(rotation) } : {}),
							})
						)
					)
					const prepared = yield* parsePreparedRun(
						yield* (yield* FileSystem.FileSystem).readFileString(
							fixture.paths.prepared
						)
					)
					expect(prepared.status).toBe('ready')
					if (prepared.status !== 'ready') return
					expect(prepared.replies).toHaveLength(MAX_REPLY_THREADS)
					expect(prepared.replies?.[0]?.threadId).toBe(
						`thread-${rotation === 0 ? 0 : MAX_REPLY_THREADS}`
					)
				})
		)
})

layer(FileSystemLayer)('prepare named converse', test => {
	for (const scenario of ['app', 'off', 'job token'] as const)
		test.effect(
			`${scenario} forwards naming and the dispatched reply only for an enabled app rating`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture([], scenario !== 'job token')
					const pr = fixture.api.command.pullRequest
					fixture.api.command.pullRequest = {
						...pr,
						base: { ...pr.base, sha: fixture.base },
						head: { ...pr.head, sha: fixture.head },
					}
					const rules = {
						...fixture.rules,
						config: {
							...fixture.rules.config,
							risk: {
								...fixture.rules.config.risk,
								enabled: scenario !== 'off',
							},
						},
					}
					const readPendingSpy = vi.fn(() =>
						Effect.succeed({ threads: [], replies: [pendingReply()] })
					)
					yield* runPrepareStep.pipe(
						Effect.provideService(ReplyFindService, {
							readPending: readPendingSpy,
							find: () => Effect.die('unused'),
						}),
						Effect.provide(
							PrepareRunServiceLive.pipe(
								Layer.provide(
									Layer.succeed(RulesService, {
										load: () => Effect.succeed(rules),
									})
								)
							)
						),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(
							fixture.envLayer({
								GITHUB_EVENT_NAME: 'workflow_dispatch',
								MNG_REVIEW_TRIGGER: 'converse',
								MNG_REVIEW_TARGET_PR: '17',
								MNG_REVIEW_TARGET_BASE: fixture.base,
								MNG_REVIEW_TARGET_HEAD: fixture.head,
								MNG_REVIEW_HELD_REPLY: '42',
							})
						)
					)
					expect(readPendingSpy).toHaveBeenCalledOnce()
					expect(readPendingSpy).toHaveBeenCalledWith({
						pullNumber: 17,
						rotation: 0,
						...(scenario === 'app' ? { naming: true, held: 42 } : {}),
					})
				})
		)
})

layer(FileSystemLayer)('prepare step null nodes', test => {
	for (const riskEnabled of [false, true])
		test.effect(
			`a review thread GitHub lists as a null node ${riskEnabled ? 'fails the thread read while the rules rate' : 'is left out while the rules do not rate'}`,
			() =>
				Effect.gen(function* () {
					const fixture = stepFixture(
						undefined,
						false,
						false,
						undefined,
						undefined,
						undefined,
						riskEnabled
					)
					fixture.api.threads.push({ ...reviewThread(), id: 'owned' })
					fixture.api.nullNodes.threads = 1
					yield* runPrepareStep.pipe(
						Effect.provide(
							PrepareRunServiceLive.pipe(Layer.provide(fixture.rulesLayer))
						),
						Effect.provide(fixture.publisherLayer),
						Effect.provide(fixture.envLayer())
					)
					const prepared = yield* parsePreparedRun(
						yield* (yield* FileSystem.FileSystem).readFileString(
							fixture.paths.prepared
						)
					)
					expect(prepared).toMatchObject({ status: 'ready' })
					if (prepared.status === 'ready')
						expect(prepared.threads.map(thread => thread.id)).toEqual(
							riskEnabled ? [] : ['owned']
						)
				})
		)
})
