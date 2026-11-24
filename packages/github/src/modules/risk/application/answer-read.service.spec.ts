import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
	GITHUB_ACTIONS_IDENTITY,
	toOwnedIdentities,
} from '../../../platform/bot-identity.helper'
import { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { githubRiskFake } from '../../../shared/mocks/github-risk-fake.helper'
import {
	appSummary,
	APP_MODE_OWNED,
	APP_IDENTITY,
} from '../../../shared/mocks/publish-test.helper'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import { toAnswerEntry } from '../domain/answer.helper'
import { AnswerReadService, AnswerReadServiceLive } from './answer-read.service'

const TIME = '2026-01-01T12:00:00Z'
/** When the fixture run started: after every command at `TIME`. */
const STARTED = '2026-01-01T12:30:00Z'
const ROLE_NOT_FOUND = new GitHubApiError({
	operation: 'getCollaboratorRole',
	status: 404,
	reason: 'not a collaborator',
})

/** A command at a known version by a writer. */
function command(id: number, body = '@mng-review review') {
	return appSummary(undefined, {
		databaseId: id,
		body,
		createdAt: TIME,
		author: { __typename: 'User', login: 'writer' },
	})
}

/** The `review` entry the live service names over the fakes. */
function readReviewEntry(api: ReturnType<typeof githubApiFake>) {
	return AnswerReadService.use(service =>
		service.getCommandEntry({
			pullNumber: 17,
			run: 7,
			kind: 'review',
			before: STARTED,
		})
	).pipe(
		Effect.provide(
			AnswerReadServiceLive.pipe(
				Layer.provide(Layer.merge(api.api, githubRiskFake().layer))
			)
		)
	)
}

layer(APP_MODE_OWNED)('AnswerReadService', test => {
	test.effect('a command an app posted for its author is not acted on', () =>
		Effect.gen(function* () {
			const api = githubApiFake()
			api.command.comment = {
				...api.command.comment,
				performed_via_github_app: { slug: 'helper' },
			}
			api.comments.push(command(1))
			expect(yield* readReviewEntry(api)).toBeUndefined()
			expect(api.reads).toContain('getIssueComment:1')
		})
	)
	for (const [label, created, named] of [
		['created after it names it', '2026-01-01T12:00:01Z', true],
		['created in its second leaves it', TIME, false],
		[
			'queued before it and started after leaves it',
			'2026-01-01T11:59:00Z',
			false,
		],
	] as const)
		test.effect(`a run ${label} for a later qualifying run`, () =>
			Effect.gen(function* () {
				const api = githubApiFake()
				const risk = githubRiskFake()
				risk.created.set(7, created)
				api.comments.push(command(1))
				const entry = yield* AnswerReadService.use(service =>
					service.getCommandEntry({
						pullNumber: 17,
						run: 7,
						kind: 'review',
						before: STARTED,
					})
				).pipe(
					Effect.provide(
						AnswerReadServiceLive.pipe(
							Layer.provide(Layer.merge(api.api, risk.layer))
						)
					)
				)
				expect(entry).toEqual(
					named
						? {
								run: 7,
								kind: 'review',
								created,
								ids: [expect.objectContaining({ id: 1 })],
							}
						: undefined
				)
			})
		)
	test.effect('a failed run read names nothing', () =>
		Effect.gen(function* () {
			const api = githubApiFake()
			const risk = githubRiskFake()
			risk.created.set(
				7,
				new GitHubApiError({ operation: 'getRun', reason: 'gone' })
			)
			api.comments.push(command(1))
			expect(
				yield* AnswerReadService.use(service =>
					service.getCommandEntry({
						pullNumber: 17,
						run: 7,
						kind: 'review',
						before: STARTED,
					})
				).pipe(
					Effect.provide(
						AnswerReadServiceLive.pipe(
							Layer.provide(Layer.merge(api.api, risk.layer))
						)
					),
					Effect.flip
				)
			).toMatchObject({ _tag: 'GitHubApiError' })
		})
	)
	for (const kind of ['review', 'run'] as const)
		test.effect(
			`${kind} names only unanswered commands for its own kind and agent`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake()
					const risk = githubRiskFake()
					api.comments.push(
						command(1),
						command(2),
						command(3, '@mng-review run auth'),
						command(4, '@mng-review run storage')
					)
					const denied = toAnswerEntry(1, 'deny', [
						{ id: 1, at: TIME, body: '@mng-review review' },
					])
					api.comments.push(
						appSummary(undefined, {
							body: toMarkerComment('answer', {
								v: 1,
								answers: denied ? [denied] : [],
							}),
							author: { __typename: 'Bot', login: APP_IDENTITY.login },
						})
					)
					const entry = yield* AnswerReadService.use(service =>
						service.getCommandEntry({
							pullNumber: 17,
							run: 7,
							kind,
							before: STARTED,
							...(kind === 'run' ? { agent: 'auth' } : {}),
						})
					).pipe(
						Effect.provide(
							AnswerReadServiceLive.pipe(
								Layer.provide(Layer.merge(api.api, risk.layer))
							)
						)
					)
					expect(entry).toMatchObject({
						run: 7,
						kind,
						ids: [{ id: kind === 'review' ? 2 : 3 }],
					})
					expect(entry?.ids).toHaveLength(1)
					if (kind === 'run') expect(entry?.agent).toBe('auth')
				})
		)
	test.effect(
		'the head cap uses timeline arrival and ignores run commands and current denials',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake()
				const risk = githubRiskFake()
				api.comments.push(
					...[1, 2, 3, 4, 5, 6].map(id =>
						command(
							id,
							id === 5 ? '@mng-review run auth' : '@mng-review review'
						)
					)
				)
				risk.timeline.push(
					{ __typename: 'IssueComment', databaseId: 1 },
					{ __typename: 'PullRequestCommit', commit: { oid: 'head' } },
					...[2, 3, 4, 5, 6].map(databaseId => ({
						__typename: 'IssueComment',
						databaseId,
					}))
				)
				const entry = toAnswerEntry(9, 'deny', [
					{ id: 3, at: TIME, body: '@mng-review review' },
				])
				api.comments.push(
					appSummary(undefined, {
						body: toMarkerComment('answer', {
							v: 1,
							answers: entry ? [entry] : [],
						}),
					})
				)
				expect(
					(yield* AnswerReadService.use(service =>
						service.getCountedReviews({
							pullNumber: 17,
							head: 'head',
							commentId: 6,
							cap: 3,
						})
					).pipe(
						Effect.provide(
							AnswerReadServiceLive.pipe(
								Layer.provide(Layer.merge(api.api, risk.layer))
							)
						)
					)).map(comment => comment.id)
				).toEqual([2, 4, 6])
			})
	)
	test.effect(
		'names only commands whose current version is from before the run started, the same second excluded',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake()
				api.comments.push(
					command(1),
					appSummary(undefined, {
						databaseId: 2,
						body: '@mng-review review',
						createdAt: '2026-01-01T12:45:00Z',
						author: { __typename: 'User', login: 'writer' },
					}),
					appSummary(undefined, {
						databaseId: 3,
						body: '@mng-review review',
						createdAt: TIME,
						lastEditedAt: '2026-01-01T12:31:00Z',
						author: { __typename: 'User', login: 'writer' },
					}),
					appSummary(undefined, {
						databaseId: 4,
						body: '@mng-review review',
						createdAt: STARTED,
						author: { __typename: 'User', login: 'writer' },
					}),
					appSummary(undefined, {
						databaseId: 5,
						body: '@mng-review review',
						createdAt: TIME,
						lastEditedAt: STARTED,
						author: { __typename: 'User', login: 'writer' },
					})
				)
				expect(
					(yield* readReviewEntry(api))?.ids.map(named => named.id)
				).toEqual([1])
			})
	)
	test.effect("reads each command author's role once per read", () =>
		Effect.gen(function* () {
			const api = githubApiFake()
			api.comments.push(command(1), command(2), command(3))
			expect((yield* readReviewEntry(api))?.ids.map(named => named.id)).toEqual(
				[1, 2, 3]
			)
			expect(
				api.reads.filter(read => read.startsWith('getCollaboratorRole:'))
			).toEqual(['getCollaboratorRole:writer'])
		})
	)
	test.effect('does not name commands by an author without write access', () =>
		Effect.gen(function* () {
			const api = githubApiFake()
			api.command.role = 'read'
			api.comments.push(command(1))
			expect(
				yield* AnswerReadService.use(service =>
					service.getCommandEntry({
						pullNumber: 17,
						run: 7,
						kind: 'review',
						before: STARTED,
					})
				).pipe(
					Effect.provide(
						AnswerReadServiceLive.pipe(
							Layer.provide(Layer.merge(api.api, githubRiskFake().layer))
						)
					)
				)
			).toBeUndefined()
		})
	)
	for (const author of [
		GITHUB_ACTIONS_IDENTITY.login,
		'mng-review-old',
	] as const)
		test.effect(
			`an answer by the earlier identity ${author} names nothing for the current app`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake()
					api.comments.push(command(1))
					const entry = toAnswerEntry(3, 'review', [
						{ id: 1, at: TIME, body: '@mng-review review' },
					])
					api.comments.push(
						appSummary(undefined, {
							databaseId: 200,
							body: toMarkerComment('answer', {
								v: 1,
								answers: entry ? [entry] : [],
							}),
							author: { __typename: 'Bot', login: author },
						})
					)
					expect(
						(yield* readReviewEntry(api).pipe(
							Effect.provideService(OwnedIdentities, {
								current: APP_IDENTITY,
								identities: toOwnedIdentities(APP_IDENTITY, [
									GITHUB_ACTIONS_IDENTITY.login,
									'mng-review-old',
								]),
							})
						))?.ids.map(named => named.id)
					).toEqual([1])
				})
		)
	test.effect(
		'a command by a confirmed non-collaborator is not acted on and fails no read',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake()
				api.comments.push(
					appSummary(undefined, {
						databaseId: 1,
						body: '@mng-review review',
						createdAt: TIME,
						author: { __typename: 'User', login: 'outsider' },
					}),
					command(2)
				)
				api.failures.getCollaboratorRole.push(ROLE_NOT_FOUND)
				expect(
					(yield* readReviewEntry(api))?.ids.map(named => named.id)
				).toEqual([2])
			})
	)
	test.effect('any other failed role read fails the read', () =>
		Effect.gen(function* () {
			const api = githubApiFake()
			api.comments.push(command(1))
			api.failures.getCollaboratorRole.push(
				new GitHubApiError({
					operation: 'getCollaboratorRole',
					status: 502,
					reason: 'unavailable',
				})
			)
			expect((yield* Effect.flip(readReviewEntry(api))).status).toBe(502)
		})
	)
})
