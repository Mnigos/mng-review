import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	threadReply,
} from '../../../shared/mocks/publish-test.helper'
import {
	decidedReply,
	pendingBotThread,
} from '../../../shared/mocks/thread-reply-test.helper'
import { toAnswerEntry } from '../../risk/domain/answer.helper'
import { toBodyDigest } from '../domain/bot-thread.helper'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import {
	ReplyNamingService,
	ReplyNamingServiceLive,
} from './reply-naming.service'

const TIME = '2026-01-01T12:00:00Z'

/** A reply from a writer with a stable id and timestamp. */
function writerReply(id: number, body = 'confirmed') {
	return threadReply({
		databaseId: id,
		body,
		createdAt: TIME,
		author: { __typename: 'User', login: 'writer' },
	})
}

/** An app answer created at `createdAt` whose reply marker names each reply at the given version. */
function appAnswer(
	createdAt: string,
	named: readonly { id: number; at: string; body: string }[],
	login: string = APP_IDENTITY.login
) {
	const entry = toAnswerEntry(6, 'converse', named)
	return threadReply({
		databaseId: 900 + named.length,
		createdAt,
		author: { __typename: 'Bot', login },
		body: toMarkerComment('reply', {
			v: 1,
			action: 'seen',
			reply: named[0]?.id ?? 0,
			commit: 'head',
			answers: entry ? [entry] : [],
		}),
	})
}

/** `readNamed` for the writer's reply 42 at `body`, as a run with an id answers it. */
function readNamed42(api: ReturnType<typeof githubApiFake>, body: string) {
	return ReplyNamingService.use(service =>
		service.readNamed(
			{
				thread: pendingBotThread({ latestDigest: toBodyDigest(body) }),
				commentId: 42,
				digest: toBodyDigest(body),
				decision: { action: 'seen' },
			},
			7
		)
	).pipe(Effect.provide(ReplyNamingServiceLive.pipe(Layer.provide(api.api))))
}

layer(APP_MODE_OWNED)('ReplyNamingService', test => {
	test.effect(
		'the answer names every unnamed writer reply its read saw and no later post',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake(APP_IDENTITY)
				const comments = [writerReply(40, 'first'), writerReply(42)]
				api.threadComments.set('thread', comments)
				const named = yield* ReplyNamingService.use(service =>
					service.readNamed(
						{
							thread: pendingBotThread({
								latestDigest: toBodyDigest('confirmed'),
							}),
							commentId: 42,
							digest: toBodyDigest('confirmed'),
							decision: { action: 'seen' },
						},
						7
					)
				).pipe(
					Effect.provide(ReplyNamingServiceLive.pipe(Layer.provide(api.api)))
				)
				comments.push(writerReply(43, 'posted after the read'))
				expect(named?.entry?.ids.map(comment => comment.id)).toEqual([40, 42])
			})
	)
	test.effect(
		'picks an older edited reply when the latest comment is an app answer',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake(APP_IDENTITY)
				const entry = toAnswerEntry(6, 'converse', [
					{ id: 42, at: TIME, body: 'confirmed' },
				])
				api.threadComments.set('thread', [
					writerReply(42, 'confirmed.'),
					threadReply({
						databaseId: 50,
						author: { __typename: 'Bot', login: APP_IDENTITY.login },
						body: toMarkerComment('reply', {
							v: 1,
							action: 'seen',
							reply: 42,
							commit: 'head',
							answers: entry ? [entry] : [],
						}),
					}),
				])
				const service = yield* ReplyNamingService.pipe(
					Effect.provide(ReplyNamingServiceLive.pipe(Layer.provide(api.api)))
				)
				expect(
					yield* service.findOlderReplies(
						{
							pullNumber: 17,
							threads: [
								pendingBotThread({ latestCommentId: 50, latestMarked: true }),
							],
							rotation: 0,
							waiting: [],
							naming: true,
						},
						[]
					)
				).toHaveLength(1)
			})
	)
	test.effect(
		'a reply already named at its current version is never answered twice',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake(APP_IDENTITY)
				const entry = toAnswerEntry(6, 'converse', [
					{ id: 42, at: TIME, body: 'confirmed' },
				])
				api.threadComments.set('thread', [
					writerReply(42),
					threadReply({
						author: { __typename: 'Bot', login: APP_IDENTITY.login },
						createdAt: TIME,
						body: toMarkerComment('reply', {
							v: 1,
							action: 'seen',
							reply: 42,
							commit: 'head',
							answers: entry ? [entry] : [],
						}),
					}),
				])
				expect(
					yield* ReplyNamingService.use(service =>
						service.readNamed(
							{
								thread: pendingBotThread(),
								...decidedReply(),
								digest: toBodyDigest('confirmed'),
							},
							7
						)
					).pipe(
						Effect.provide(ReplyNamingServiceLive.pipe(Layer.provide(api.api)))
					)
				).toBeUndefined()
			})
	)
	for (const later of ['named', 'unnamed'] as const)
		test.effect(
			`an older edited reply with a later ${later} reply is ${later === 'named' ? 'answered' : 'held back'}`,
			() =>
				Effect.gen(function* () {
					const api = githubApiFake(APP_IDENTITY)
					const edited = 'confirmed, edited'
					const later44 = { id: 44, at: '2026-01-02T12:00:00Z', body: 'later' }
					api.threadComments.set('thread', [
						threadReply({
							databaseId: 42,
							body: edited,
							createdAt: TIME,
							lastEditedAt: '2026-01-03T12:00:00Z',
							author: { __typename: 'User', login: 'writer' },
						}),
						appAnswer('2026-01-01T13:00:00Z', [
							{ id: 42, at: TIME, body: 'confirmed' },
						]),
						threadReply({
							databaseId: 44,
							body: later44.body,
							createdAt: later44.at,
							author: { __typename: 'User', login: 'writer' },
						}),
						...(later === 'named'
							? [appAnswer('2026-01-02T13:00:00Z', [later44])]
							: []),
					])
					expect(
						(yield* readNamed42(api, edited))?.entry?.ids.map(
							comment => comment.id
						)
					).toEqual(later === 'named' ? [42] : undefined)
				})
		)
	test.effect(
		'an answer by an earlier identity does not name a reply for the current app',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake(APP_IDENTITY)
				api.threadComments.set('thread', [
					writerReply(42),
					appAnswer(
						'2026-01-01T13:00:00Z',
						[{ id: 42, at: TIME, body: 'confirmed' }],
						GITHUB_ACTIONS_IDENTITY.login
					),
				])
				expect(
					(yield* readNamed42(api, 'confirmed'))?.entry?.ids.map(
						comment => comment.id
					)
				).toEqual([42])
			})
	)
})
