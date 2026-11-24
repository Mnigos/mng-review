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
		'reads a comment body with its edit count, edit ids, editors, times, texts and null edits',
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
											null,
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
						null,
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
