import { layer } from '@effect/vitest'
import { DEFAULT_PRESET } from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	appSummary,
} from '../../../shared/mocks/publish-test.helper'
import type {
	CommandComment,
	CommandDecision,
} from '../../command/domain/command.types'
import { parseAnswerMarker } from '../../publish/domain/publish-marker.parser'
import { toAnsweredComment } from '../domain/answer.helper'
import { AnswerReadService } from './answer-read.service'
import {
	CommandAnswerService,
	CommandAnswerServiceLive,
} from './command-answer.service'

const COMMENT = {
	eventName: 'issue_comment',
	action: 'created',
	id: 23,
	body: '@mng-review review',
	login: 'writer',
	type: 'User',
	viaApp: false,
	issueNumber: 17,
	onPullRequest: true,
} as const satisfies CommandComment
const AUTHORIZED = {
	status: 'authorized',
	pullNumber: 17,
	base: 'a'.repeat(40),
	head: 'b'.repeat(40),
} as const satisfies CommandDecision
const ENABLED = {
	...DEFAULT_PRESET,
	risk: { ...DEFAULT_PRESET.risk, enabled: true, reviews_per_head: 3 },
} as const

/** A failed role or cap read: a 404 is a confirmed non-collaborator, any other status is not. */
function apiError(operation: string, status: number) {
	return new GitHubApiError({ operation, status, reason: 'refused' })
}

/** The real denial service with recorded cap reads and in-memory comments. */
function setup(capFailure?: GitHubApiError) {
	const api = githubApiFake(APP_IDENTITY)
	api.command.role = 'write'
	const capReads: number[] = []
	const answers = Layer.succeed(AnswerReadService, {
		readCommands: () => Effect.die('unused command read'),
		getCommandEntry: () => Effect.die('unused answer read'),
		getCountedReviews: request =>
			Effect.gen(function* () {
				capReads.push(request.commentId)
				if (capFailure) return yield* capFailure
				return [1, 2, 3, 23].map(id => ({
					id,
					at: '2026-01-01T12:00:00Z',
					body: COMMENT.body,
					review: true,
					actedOn: true,
				}))
			}),
	})
	return {
		api,
		capReads,
		live: CommandAnswerServiceLive.pipe(
			Layer.provide(Layer.merge(api.api, answers))
		),
	}
}

layer(APP_MODE_OWNED)('CommandAnswerService', test => {
	test.effect(
		'the fourth review is refused before a rating can be authorized',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				expect(
					yield* CommandAnswerService.use(service =>
						service.check({
							comment: COMMENT,
							decision: AUTHORIZED,
							config: ENABLED,
						})
					).pipe(Effect.provide(fixture.live))
				).toMatchObject({
					status: 'denied',
					answer: 'cap',
					commentId: 23,
					pullNumber: 17,
				})
				expect(fixture.capReads).toEqual([23])
				expect(fixture.api.writes).toEqual([])
			})
	)
	for (const scenario of ['owner gate', 'edited'] as const)
		test.effect(`a writer refused by ${scenario} gets a denial`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				const decision = yield* CommandAnswerService.use(service =>
					service.check({
						comment: {
							...COMMENT,
							action: scenario === 'edited' ? 'edited' : 'created',
						},
						decision: { status: 'denied', reason: 'owner access required' },
						config: ENABLED,
					})
				).pipe(Effect.provide(fixture.live))
				expect(decision).toMatchObject({
					status: 'denied',
					answer: 'deny',
					commentId: 23,
					...(scenario === 'edited'
						? { reason: 'the comment changed; post a new command' }
						: {}),
				})
				expect(fixture.capReads).toEqual([])
			})
		)
	for (const scenario of [
		'reader',
		'bot',
		'via app',
		'owned person login',
		'off',
		'run',
	] as const)
		test.effect(`${scenario} creates no new cap or denial answer`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				if (scenario === 'reader') fixture.api.command.role = 'read'
				const decision: CommandDecision =
					scenario === 'run'
						? { ...AUTHORIZED, agent: 'auth' }
						: { status: 'denied', reason: 'not allowed' }
				expect(
					yield* CommandAnswerService.use(service =>
						service.check({
							comment: {
								...COMMENT,
								...(scenario === 'bot' ? { type: 'Bot' } : {}),
								...(scenario === 'via app' ? { viaApp: true } : {}),
								...(scenario === 'owned person login'
									? { login: APP_IDENTITY.login }
									: {}),
								...(scenario === 'run' ? { body: '@mng-review run auth' } : {}),
							},
							decision,
							config: scenario === 'off' ? DEFAULT_PRESET : ENABLED,
						})
					).pipe(Effect.provide(fixture.live))
				).toEqual(decision)
				expect(fixture.capReads).toEqual([])
			})
		)
	for (const kind of ['deny', 'cap'] as const)
		test.effect(
			`${kind} posts a new comment naming the command's current version`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const version = {
						id: 23,
						at: '2026-01-02T12:00:00Z',
						body: '@mng-review review deep',
					}
					fixture.api.comments.push(
						appSummary(undefined, {
							databaseId: 23,
							body: version.body,
							createdAt: '2026-01-01T12:00:00Z',
							lastEditedAt: version.at,
							author: { __typename: 'User', login: 'writer' },
						})
					)
					expect(
						yield* CommandAnswerService.use(service =>
							service.post({
								pullNumber: 17,
								commentId: 23,
								run: 9,
								kind,
								reason: 'refused',
							})
						).pipe(Effect.provide(fixture.live))
					).toBe(true)
					expect(fixture.api.writes).toHaveLength(1)
					const [write] = fixture.api.writes
					expect(write?.method).toBe('create')
					if (write?.method !== 'create') return
					expect(parseAnswerMarker(write.body)?.answers).toEqual([
						{ run: 9, kind, ids: [toAnsweredComment(version)] },
					])
				})
		)
	test.effect('a removed command gets no denial comment', () =>
		Effect.gen(function* () {
			const fixture = setup()
			fixture.api.comments.push(
				appSummary(undefined, {
					databaseId: 23,
					body: 'command removed',
					createdAt: '2026-01-01T12:00:00Z',
				})
			)
			expect(
				yield* CommandAnswerService.use(service =>
					service.post({
						pullNumber: 17,
						commentId: 23,
						run: 9,
						kind: 'deny',
						reason: 'refused',
					})
				).pipe(Effect.provide(fixture.live))
			).toBe(false)
			expect(fixture.api.writes).toEqual([])
		})
	)
	test.effect(
		'a command by a confirmed non-collaborator gets no answer and keeps its decision',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.api.failures.getCollaboratorRole.push(
					apiError('getCollaboratorRole', 404)
				)
				const decision: CommandDecision = {
					status: 'denied',
					reason: 'not allowed',
				}
				expect(
					yield* CommandAnswerService.use(service =>
						service.check({ comment: COMMENT, decision, config: ENABLED })
					).pipe(Effect.provide(fixture.live))
				).toEqual(decision)
				expect(fixture.capReads).toEqual([])
			})
	)
	for (const failure of ['role', 'cap'] as const)
		test.effect(`a failed ${failure} read fails the check`, () =>
			Effect.gen(function* () {
				const fixture = setup(
					failure === 'cap' ? apiError('timeline', 502) : undefined
				)
				if (failure === 'role')
					fixture.api.failures.getCollaboratorRole.push(
						apiError('getCollaboratorRole', 502)
					)
				const error = yield* Effect.flip(
					CommandAnswerService.use(service =>
						service.check({
							comment: COMMENT,
							decision: AUTHORIZED,
							config: ENABLED,
						})
					).pipe(Effect.provide(fixture.live))
				)
				expect(error).toBeInstanceOf(GitHubApiError)
				expect(error.status).toBe(502)
			})
		)
})
