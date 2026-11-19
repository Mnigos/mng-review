import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { UrlParams } from 'effect/http'
import {
	makeGitHubHttp,
	getGitHubRequestBody,
	GITHUB_SETTINGS,
} from '../shared/mocks/github-http.helper'
import { PAGE_SIZE } from './github-api.constants'
import {
	GitHubStatusService,
	STATUS_CONTEXT,
	BOT_REST_LOGIN,
} from './github-status.service'

const BOT_STATUS = {
	id: 17,
	state: 'failure',
	context: STATUS_CONTEXT,
	description: '1 open bug',
	creator: { login: BOT_REST_LOGIN, type: 'Bot' },
} as const
const REPO_URL = `${GITHUB_SETTINGS.apiUrl}/repos/${GITHUB_SETTINGS.owner}/${GITHUB_SETTINGS.name}`

layer(Layer.empty)('GitHubStatusService', test => {
	test.effect(
		'posts a completed check with a nonblocking conclusion and output',
		() =>
			Effect.gen(function* () {
				const fake = makeGitHubHttp(() =>
					Effect.succeed(Response.json({ id: 1 }, { status: 201 }))
				)
				yield* GitHubStatusService.use(service =>
					service.createCheckRun({
						headSha: 'head',
						name: 'MNG Review · storage',
						conclusion: 'neutral',
						title: 'Needs attention',
						summary: 'Finding detail',
					})
				).pipe(Effect.provide(fake.statusLayer))
				expect(fake.requests).toHaveLength(1)
				expect(fake.requests[0]).toMatchObject({
					method: 'POST',
					url: `${REPO_URL}/check-runs`,
				})
				expect(getGitHubRequestBody(fake.requests[0])).toEqual({
					name: 'MNG Review · storage',
					head_sha: 'head',
					status: 'completed',
					conclusion: 'neutral',
					output: { title: 'Needs attention', summary: 'Finding detail' },
				})
			})
	)
	for (const length of [139, 140, 141, 500])
		test.effect(
			`status descriptions with ${length} characters respect the API cap`,
			() =>
				Effect.gen(function* () {
					const fake = makeGitHubHttp(() =>
						Effect.succeed(Response.json({ id: 1 }))
					)
					yield* GitHubStatusService.use(service =>
						service.setStatus({
							sha: 'head',
							state: 'failure',
							description: 'x'.repeat(length),
						})
					).pipe(Effect.provide(fake.statusLayer))
					expect(fake.requests[0]).toMatchObject({
						method: 'POST',
						url: `${REPO_URL}/statuses/head`,
					})
					expect(getGitHubRequestBody(fake.requests[0])).toEqual({
						state: 'failure',
						context: STATUS_CONTEXT,
						description: 'x'.repeat(Math.min(140, length)),
					})
				})
		)
	test.effect(
		'chooses the newest status with exactly the bot login, type and context',
		() =>
			Effect.gen(function* () {
				const fake = makeGitHubHttp(() =>
					Effect.succeed(
						Response.json([
							{ ...BOT_STATUS, context: 'Other' },
							{ ...BOT_STATUS, creator: null },
							{
								...BOT_STATUS,
								creator: { login: BOT_REST_LOGIN, type: 'User' },
							},
							{ ...BOT_STATUS, creator: { login: 'other-bot', type: 'Bot' } },
							BOT_STATUS,
							{ ...BOT_STATUS, state: 'success', description: 'older' },
						])
					)
				)
				expect(
					yield* GitHubStatusService.use(service =>
						service.getStatus('head')
					).pipe(Effect.provide(fake.statusLayer))
				).toEqual(BOT_STATUS)
				expect(fake.requests[0]).toMatchObject({
					method: 'GET',
					url: `${REPO_URL}/commits/head/statuses`,
					urlParams: UrlParams.fromInput({ per_page: String(PAGE_SIZE) }),
				})
			})
	)
	test.effect(
		'returns no status when only other creators or contexts are present',
		() =>
			Effect.gen(function* () {
				const fake = makeGitHubHttp(() =>
					Effect.succeed(
						Response.json([
							{
								...BOT_STATUS,
								creator: { login: 'contributor', type: 'User' },
							},
						])
					)
				)
				expect(
					yield* GitHubStatusService.use(service =>
						service.getStatus('head')
					).pipe(Effect.provide(fake.statusLayer))
				).toBeUndefined()
			})
	)
	test.effect('reads full pages of open pulls and stops on a short page', () =>
		Effect.gen(function* () {
			const first = Array.from({ length: PAGE_SIZE }, (_, index) => ({
				number: index + 1,
				head: { sha: `head-${index}` },
			}))
			const last = { number: PAGE_SIZE + 1, head: { sha: 'last-head' } }
			const fake = makeGitHubHttp((_request, attempt) =>
				Effect.succeed(Response.json(attempt === 1 ? first : [last]))
			)
			expect(
				yield* GitHubStatusService.use(service =>
					service.listOpenPullRequests()
				).pipe(Effect.provide(fake.statusLayer))
			).toEqual([...first, last])
			expect(
				fake.requests.map(request => ({
					method: request.method,
					url: request.url,
					params: request.urlParams,
				}))
			).toEqual(
				[1, 2].map(page => ({
					method: 'GET',
					url: `${REPO_URL}/pulls`,
					params: UrlParams.fromInput({
						state: 'open',
						per_page: String(PAGE_SIZE),
						page: String(page),
					}),
				}))
			)
		})
	)
	test.effect('an empty first page returns no pull requests', () =>
		Effect.gen(function* () {
			const fake = makeGitHubHttp(() => Effect.succeed(Response.json([])))
			expect(
				yield* GitHubStatusService.use(service =>
					service.listOpenPullRequests()
				).pipe(Effect.provide(fake.statusLayer))
			).toEqual([])
			expect(fake.requests).toHaveLength(1)
		})
	)
})
