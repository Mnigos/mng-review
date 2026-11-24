import { layer } from '@effect/vitest'
import { RISK_STATUS_CONTEXT } from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import { UrlParams } from 'effect/http'
import {
	COMMENT_EDITS_BOT,
	EDITED_COMMENT_PAGES,
	getEditedCommentEdits,
} from '../shared/mocks/comment-edits.helper'
import {
	makeGitHubHttp,
	getGitHubRequestBody,
	GITHUB_SETTINGS,
} from '../shared/mocks/github-http.helper'
import { riskStatus } from '../shared/mocks/github-status-fake.helper'
import { MAX_PAGES, PAGE_SIZE } from './github-api.constants'
import {
	COMMENT_EDIT_PAGES,
	COMMENT_EDITS_QUERY,
	GitHubRiskService,
	TIMELINE_QUERY,
} from './github-risk.service'

const REPO_URL = `${GITHUB_SETTINGS.apiUrl}/repos/${GITHUB_SETTINGS.owner}/${GITHUB_SETTINGS.name}`

/** One page of an edit history that counts `total` edits and lists one. */
function editsPage(
	total: number,
	hasNextPage: boolean,
	endCursor: string | null
) {
	return {
		data: {
			node: {
				body: 'marker',
				userContentEdits: {
					totalCount: total,
					pageInfo: { hasNextPage, endCursor },
					nodes: [
						{
							id: 'edit',
							editor: null,
							editedAt: '2026-01-01T00:00:00Z',
							diff: null,
						},
					],
				},
			},
		},
	}
}

layer(Layer.empty)('GitHubRiskService HTTP boundary', test => {
	test.effect('reads a workflow run creation time', () =>
		Effect.gen(function* () {
			const fake = makeGitHubHttp(() =>
				Effect.succeed(
					Response.json({ id: 7, created_at: '2026-01-01T12:00:00Z' })
				)
			)
			expect(
				yield* GitHubRiskService.use(service => service.getRunCreated(7)).pipe(
					Effect.provide(fake.riskLayer)
				)
			).toBe('2026-01-01T12:00:00Z')
			expect(fake.requests.map(request => request.url)).toEqual([
				`${REPO_URL}/actions/runs/7`,
			])
		})
	)
	test.effect(
		'reads all status pages without dropping other numbers or creators at the transport boundary',
		() =>
			Effect.gen(function* () {
				const first = Array.from({ length: PAGE_SIZE }, (_, index) =>
					riskStatus({ id: index + 2 })
				)
				const last = riskStatus({ id: 1 }, { pr: 18 })
				const fake = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(Response.json(attempt === 1 ? first : [last]))
				)
				expect(
					yield* GitHubRiskService.use(service =>
						service.listStatuses('head')
					).pipe(Effect.provide(fake.riskLayer))
				).toEqual([...first, last])
				expect(
					fake.requests.map(request => ({
						url: request.url,
						params: request.urlParams,
					}))
				).toEqual(
					[1, 2].map(page => ({
						url: `${REPO_URL}/commits/head/statuses`,
						params: UrlParams.fromInput({
							per_page: String(PAGE_SIZE),
							page: String(page),
						}),
					}))
				)
			})
	)
	test.effect(
		'a later status page error fails the complete read instead of returning partial history',
		() =>
			Effect.gen(function* () {
				const fake = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(
						attempt === 1
							? Response.json(
									Array.from({ length: PAGE_SIZE }, () => riskStatus())
								)
							: Response.json({ message: 'denied' }, { status: 403 })
					)
				)
				expect(
					yield* GitHubRiskService.use(service =>
						service.listStatuses('head')
					).pipe(Effect.provide(fake.riskLayer), Effect.flip)
				).toMatchObject({ _tag: 'GitHubApiError', operation: 'listStatuses' })
			})
	)
	test.effect('refuses truncated status history at the page limit', () =>
		Effect.gen(function* () {
			const fake = makeGitHubHttp(() =>
				Effect.succeed(
					Response.json(Array.from({ length: PAGE_SIZE }, () => riskStatus()))
				)
			)
			expect(
				yield* GitHubRiskService.use(service =>
					service.listStatuses('head')
				).pipe(Effect.provide(fake.riskLayer), Effect.flip)
			).toMatchObject({ _tag: 'GitHubApiError', operation: 'listStatuses' })
			expect(fake.requests).toHaveLength(MAX_PAGES)
		})
	)
	for (const length of [140, 141])
		test.effect(
			`description length ${length} is preserved or refused without truncation`,
			() =>
				Effect.gen(function* () {
					const fake = makeGitHubHttp(() =>
						Effect.succeed(Response.json({ id: 1 }, { status: 201 }))
					)
					const call = GitHubRiskService.use(service =>
						service.createStatus({
							sha: 'head',
							state: 'error',
							description: 'x'.repeat(length),
						})
					).pipe(Effect.provide(fake.riskLayer))
					if (length > 140) {
						expect(yield* call.pipe(Effect.flip)).toMatchObject({
							_tag: 'GitHubApiError',
							operation: 'createStatus',
						})
						expect(fake.requests).toEqual([])
						return
					}
					yield* call
					expect(fake.requests[0]).toMatchObject({
						method: 'POST',
						url: `${REPO_URL}/statuses/head`,
					})
					expect(getGitHubRequestBody(fake.requests[0])).toEqual({
						state: 'error',
						context: RISK_STATUS_CONTEXT,
						description: 'x'.repeat(length),
					})
				})
		)
	test.effect(
		'pages the timeline including commits and both sides of force pushes',
		() =>
			Effect.gen(function* () {
				const commit = {
					__typename: 'PullRequestCommit',
					commit: { oid: 'old' },
				}
				const force = {
					__typename: 'HeadRefForcePushedEvent',
					beforeCommit: { oid: 'before' },
					afterCommit: { oid: 'after' },
				}
				const fake = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(
						Response.json({
							data: {
								repository: {
									pullRequest: {
										timelineItems: {
											nodes: attempt === 1 ? [commit] : [force],
											pageInfo: {
												hasNextPage: attempt === 1,
												endCursor: attempt === 1 ? 'next' : null,
											},
										},
									},
								},
							},
						})
					)
				)
				expect(
					yield* GitHubRiskService.use(service =>
						service.listTimeline(17)
					).pipe(Effect.provide(fake.riskLayer))
				).toEqual([commit, force])
				expect(getGitHubRequestBody(fake.requests[0])).toMatchObject({
					query: TIMELINE_QUERY,
					variables: { number: 17, cursor: null },
				})
				expect(getGitHubRequestBody(fake.requests[1])).toMatchObject({
					variables: { cursor: 'next' },
				})
				expect(TIMELINE_QUERY).toContain(
					'beforeCommit { oid } afterCommit { oid }'
				)
				// The sweep bounds a head's runs by when it arrived.
				expect(TIMELINE_QUERY).toContain('commit { oid committedDate }')
				expect(TIMELINE_QUERY).toContain('HeadRefForcePushedEvent { createdAt')
			})
	)
	test.effect(
		'a timeline item GitHub lists as a null node fails the read, since it may be a head',
		() =>
			Effect.gen(function* () {
				const fake = makeGitHubHttp(() =>
					Effect.succeed(
						Response.json({
							data: {
								repository: {
									pullRequest: {
										timelineItems: {
											nodes: [
												{
													__typename: 'PullRequestCommit',
													commit: { oid: 'old' },
												},
												null,
											],
											pageInfo: { hasNextPage: false, endCursor: null },
										},
									},
								},
							},
						})
					)
				)
				expect(
					yield* GitHubRiskService.use(service =>
						service.listTimeline(17)
					).pipe(Effect.provide(fake.riskLayer), Effect.flip)
				).toMatchObject({ _tag: 'GitHubApiError', operation: 'listTimeline' })
			})
	)
	test.effect(
		'GraphQL timeline errors fail rather than returning empty history',
		() =>
			Effect.gen(function* () {
				const fake = makeGitHubHttp(() =>
					Effect.succeed(
						Response.json(
							{ errors: [{ message: 'not allowed', type: 'FORBIDDEN' }] },
							{ status: 403 }
						)
					)
				)
				expect(
					yield* GitHubRiskService.use(service =>
						service.listTimeline(17)
					).pipe(Effect.provide(fake.riskLayer), Effect.flip)
				).toMatchObject({ _tag: 'GitHubApiError', operation: 'listTimeline' })
			})
	)
	test.effect(
		'reads a comment body with its edit count, edit ids, editors, times and texts',
		() =>
			Effect.gen(function* () {
				const fake = makeGitHubHttp(() =>
					Effect.succeed(
						Response.json({
							data: {
								node: {
									body: 'marker',
									userContentEdits: {
										totalCount: 3,
										pageInfo: { hasNextPage: false, endCursor: null },
										nodes: [
											{
												id: 'edit-2',
												editor: { __typename: 'Bot', login: 'mng-review' },
												editedAt: '2026-01-01T00:02:00Z',
												diff: 'marker',
											},
											{
												id: 'edit-1',
												editor: null,
												editedAt: '2026-01-01T00:01:00Z',
												diff: null,
											},
										],
									},
								},
							},
						})
					)
				)
				expect(
					yield* GitHubRiskService.use(service =>
						service.readCommentEdits('comment-node')
					).pipe(Effect.provide(fake.riskLayer))
				).toEqual({
					body: 'marker',
					total: 3,
					edits: [
						{
							id: 'edit-2',
							editor: { __typename: 'Bot', login: 'mng-review' },
							editedAt: '2026-01-01T00:02:00Z',
							diff: 'marker',
						},
						{
							id: 'edit-1',
							editor: null,
							editedAt: '2026-01-01T00:01:00Z',
							diff: null,
						},
					],
				})
				expect(getGitHubRequestBody(fake.requests[0])).toMatchObject({
					query: COMMENT_EDITS_QUERY,
					variables: { id: 'comment-node', cursor: null },
				})
				expect(COMMENT_EDITS_QUERY).toContain(
					`userContentEdits(first: ${PAGE_SIZE}, after: $cursor)`
				)
				expect(COMMENT_EDITS_QUERY).toContain(
					'nodes { id editedAt editor { __typename login } diff }'
				)
			})
	)
	test.effect(
		'reads every page of a real edit history with the cursor GitHub gave',
		() =>
			Effect.gen(function* () {
				const fake = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(Response.json(EDITED_COMMENT_PAGES[attempt - 1]))
				)
				const read = yield* GitHubRiskService.use(service =>
					service.readCommentEdits('comment-node')
				).pipe(Effect.provide(fake.riskLayer))
				expect(read.total).toBe(4)
				expect(read.edits).toEqual(getEditedCommentEdits())
				// GitHub's `diff` is the whole text an edit left, so the newest one's is the body.
				expect(read.edits[0]?.diff).toBe(read.body)
				expect(new Set(read.edits.map(edit => edit.diff)).size).toBe(4)
				expect(read.edits.at(-1)?.editor?.login).toBe(COMMENT_EDITS_BOT)
				expect(fake.requests.map(getGitHubRequestBody)).toEqual([
					expect.objectContaining({
						variables: { id: 'comment-node', cursor: null },
					}),
					expect.objectContaining({
						variables: {
							id: 'comment-node',
							cursor:
								EDITED_COMMENT_PAGES[0].data.node.userContentEdits.pageInfo
									.endCursor,
						},
					}),
				])
			})
	)
	for (const [name, answer] of [
		['longer than the page bound', () => editsPage(900, true, 'next')],
		[
			'whose count changes between pages',
			(attempt: number) =>
				editsPage(attempt === 1 ? 2 : 3, attempt === 1, 'next'),
		],
		['with more pages and no cursor', () => editsPage(2, true, null)],
		[
			'that lists an edit as a null node',
			() => {
				const page = editsPage(2, false, null)
				const { userContentEdits } = page.data.node
				return {
					data: {
						node: {
							...page.data.node,
							userContentEdits: {
								...userContentEdits,
								nodes: [...userContentEdits.nodes, null],
							},
						},
					},
				}
			},
		],
		[
			'whose later page lists an edit as a null node',
			(attempt: number) => {
				const page = editsPage(2, attempt === 1, 'next')
				const { userContentEdits } = page.data.node
				return attempt === 1
					? page
					: {
							data: {
								node: {
									...page.data.node,
									userContentEdits: { ...userContentEdits, nodes: [null] },
								},
							},
						}
			},
		],
		[
			'whose later page fails',
			(attempt: number) =>
				attempt === 1 ? editsPage(2, true, 'next') : { data: { node: null } },
		],
	] as const)
		test.effect(`an edit history ${name} fails the read`, () =>
			Effect.gen(function* () {
				const fake = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(Response.json(answer(attempt)))
				)
				expect(
					yield* GitHubRiskService.use(service =>
						service.readCommentEdits('comment-node')
					).pipe(Effect.provide(fake.riskLayer), Effect.flip)
				).toMatchObject({
					_tag: 'GitHubApiError',
					operation: 'readCommentEdits',
				})
				expect(fake.requests.length).toBeLessThanOrEqual(COMMENT_EDIT_PAGES)
			})
		)
	for (const answer of [
		{ data: { node: null } },
		{ data: { node: { body: 'marker' } } },
		{ errors: [{ message: 'not allowed', type: 'FORBIDDEN' }] },
	])
		test.effect(
			`an edit history read without a comment or its edits fails: ${JSON.stringify(answer)}`,
			() =>
				Effect.gen(function* () {
					const fake = makeGitHubHttp(() =>
						Effect.succeed(
							Response.json(answer, {
								status: 'errors' in answer ? 403 : 200,
							})
						)
					)
					expect(
						yield* GitHubRiskService.use(service =>
							service.readCommentEdits('comment-node')
						).pipe(Effect.provide(fake.riskLayer), Effect.flip)
					).toMatchObject({
						_tag: 'GitHubApiError',
						operation: 'readCommentEdits',
					})
				})
		)
})

const RUN = {
	id: 7,
	display_title: 'mng-review-risk-17',
	status: 'completed',
	conclusion: 'success',
	created_at: '2026-01-01T12:00:00Z',
	event: 'workflow_dispatch',
	path: '.github/workflows/review.yml',
	head_branch: 'main',
	head_repository: { id: 1 },
} as const
const SINCE = '2026-01-01T00:00:00Z'
const JOB = {
	name: 'rating',
	status: 'completed',
	conclusion: 'success',
} as const

layer(Layer.empty)('GitHubRiskService workflow calls', test => {
	test.effect(
		'lists the review workflow runs from the lower bound with the event and branch filters',
		() =>
			Effect.gen(function* () {
				const http = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(
						Response.json({
							total_count: PAGE_SIZE + 1,
							workflow_runs:
								attempt === 1
									? Array.from(
											{ length: PAGE_SIZE },
											(_: unknown, id: number) => ({ ...RUN, id })
										)
									: [RUN],
						})
					)
				)
				expect(
					yield* GitHubRiskService.use(service =>
						service.listRuns({
							workflow: 'review.yml',
							event: 'workflow_dispatch',
							branch: 'main',
							since: SINCE,
						})
					).pipe(Effect.provide(http.riskLayer))
				).toHaveLength(PAGE_SIZE + 1)
				expect(http.requests.map(request => request.url)).toEqual([
					`${REPO_URL}/actions/workflows/review.yml/runs`,
					`${REPO_URL}/actions/workflows/review.yml/runs`,
				])
				expect(
					http.requests.map(request => UrlParams.toRecord(request.urlParams))
				).toEqual(
					[1, 2].map(page => ({
						event: 'workflow_dispatch',
						branch: 'main',
						created: `>=${SINCE}`,
						per_page: String(PAGE_SIZE),
						page: String(page),
					}))
				)
			})
	)
	test.effect(
		'lists runs in flight across every workflow by status from the lower bound',
		() =>
			Effect.gen(function* () {
				const http = makeGitHubHttp(() =>
					Effect.succeed(
						Response.json({ total_count: 1, workflow_runs: [RUN] })
					)
				)
				yield* GitHubRiskService.use(service =>
					service.listRuns({ status: 'queued', since: SINCE })
				).pipe(Effect.provide(http.riskLayer))
				expect(http.requests.map(request => request.url)).toEqual([
					`${REPO_URL}/actions/runs`,
				])
				expect(
					http.requests.map(request => UrlParams.toRecord(request.urlParams))
				).toEqual([
					{
						status: 'queued',
						created: `>=${SINCE}`,
						per_page: String(PAGE_SIZE),
						page: '1',
					},
				])
			})
	)
	test.effect('stops paging at the first run older than the lower bound', () =>
		Effect.gen(function* () {
			const older = { ...RUN, id: 99, created_at: '2025-12-01T12:00:00Z' }
			const http = makeGitHubHttp(() =>
				Effect.succeed(
					Response.json({
						total_count: PAGE_SIZE + 1,
						workflow_runs: [
							...Array.from(
								{ length: PAGE_SIZE - 1 },
								(_: unknown, id: number) => ({ ...RUN, id })
							),
							older,
						],
					})
				)
			)
			const runs = yield* GitHubRiskService.use(service =>
				service.listRuns({ workflow: 'review.yml', since: SINCE })
			).pipe(Effect.provide(http.riskLayer))
			expect(runs).toHaveLength(PAGE_SIZE - 1)
			expect(runs.some(run => run.id === older.id)).toBe(false)
			expect(http.requests).toHaveLength(1)
		})
	)
	for (const scenario of ['limit', 'page error'] as const)
		test.effect(`a run listing fails closed at a ${scenario}`, () =>
			Effect.gen(function* () {
				const http = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(
						scenario === 'page error' && attempt === 2
							? Response.json({ message: 'denied' }, { status: 403 })
							: Response.json({
									total_count: MAX_PAGES * PAGE_SIZE + 1,
									workflow_runs: Array.from(
										{ length: PAGE_SIZE },
										(_: unknown, id: number) => ({ ...RUN, id })
									),
								})
					)
				)
				expect(
					yield* GitHubRiskService.use(service =>
						service.listRuns({ workflow: 'review.yml', since: SINCE })
					).pipe(Effect.provide(http.riskLayer), Effect.flip)
				).toMatchObject({ _tag: 'GitHubApiError', operation: 'listRuns' })
				expect(http.requests).toHaveLength(scenario === 'limit' ? MAX_PAGES : 2)
			})
		)
	test.effect(
		'a filtered run list GitHub cut short of its total fails closed',
		() =>
			Effect.gen(function* () {
				// GitHub answers a filtered search with at most 1,000 runs and an empty page after them.
				const listed = 1000 / PAGE_SIZE
				const http = makeGitHubHttp((_request, attempt) =>
					Effect.succeed(
						Response.json({
							total_count: 1500,
							workflow_runs:
								attempt <= listed
									? Array.from(
											{ length: PAGE_SIZE },
											(_: unknown, id: number) => ({
												...RUN,
												id: attempt * PAGE_SIZE + id,
											})
										)
									: [],
						})
					)
				)
				expect(
					yield* GitHubRiskService.use(service =>
						service.listRuns({
							workflow: 'review.yml',
							event: 'workflow_dispatch',
							since: SINCE,
						})
					).pipe(Effect.provide(http.riskLayer), Effect.flip)
				).toMatchObject({ _tag: 'GitHubApiError', operation: 'listRuns' })
				expect(http.requests).toHaveLength(listed + 1)
			})
	)
	test.effect('lists every page of run jobs without losing decide names', () =>
		Effect.gen(function* () {
			const decide = { ...JOB, name: 'decide 42@aaaaaaaaaaaaaaaa bbbbbbb' }
			const http = makeGitHubHttp((_request, attempt) =>
				Effect.succeed(
					Response.json({
						jobs:
							attempt === 1
								? Array.from({ length: PAGE_SIZE }, () => JOB)
								: [decide],
					})
				)
			)
			const jobs = yield* GitHubRiskService.use(service =>
				service.listRunJobs(7)
			).pipe(Effect.provide(http.riskLayer))
			expect(jobs).toHaveLength(PAGE_SIZE + 1)
			expect(jobs.at(-1)).toEqual(decide)
			expect(
				http.requests.every(request =>
					request.url.endsWith('/actions/runs/7/jobs')
				)
			).toBe(true)
		})
	)
	test.effect(
		'dispatches on the default ref with the comment version and accepts an empty response',
		() =>
			Effect.gen(function* () {
				const http = makeGitHubHttp(() =>
					Effect.succeed(new Response(null, { status: 204 }))
				)
				const input = {
					workflow: 'review.yml',
					ref: 'main',
					inputs: {
						number: '17',
						kind: 'converse',
						comment: '42',
						version: 'a'.repeat(16),
					},
				} as const
				yield* GitHubRiskService.use(service => service.dispatch(input)).pipe(
					Effect.provide(http.riskLayer)
				)
				expect(http.requests).toHaveLength(1)
				expect(http.requests[0]?.method).toBe('POST')
				expect(http.requests[0]?.url).toContain(
					'/actions/workflows/review.yml/dispatches'
				)
				expect(getGitHubRequestBody(http.requests[0])).toEqual({
					ref: input.ref,
					inputs: input.inputs,
				})
			})
	)
})

layer(Layer.empty)('GitHubRiskService timeline comments', test => {
	test.effect('preserves timeline comment ids for the head cap', () =>
		Effect.gen(function* () {
			const http = makeGitHubHttp(() =>
				Effect.succeed(
					Response.json({
						data: {
							repository: {
								pullRequest: {
									timelineItems: {
										pageInfo: { hasNextPage: false, endCursor: null },
										nodes: [{ __typename: 'IssueComment', databaseId: 42 }],
									},
								},
							},
						},
					})
				)
			)
			expect(
				yield* GitHubRiskService.use(service => service.listTimeline(17)).pipe(
					Effect.provide(http.riskLayer)
				)
			).toEqual([{ __typename: 'IssueComment', databaseId: 42 }])
			expect(JSON.stringify(getGitHubRequestBody(http.requests[0]))).toContain(
				'... on IssueComment { databaseId }'
			)
		})
	)
})
