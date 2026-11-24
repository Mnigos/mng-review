import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import {
	APP_IDENTITY,
	APP_MODE_IDENTITIES,
	threadReply,
} from '../../../shared/mocks/publish-test.helper'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import { toAnswerEntry } from './answer.helper'
import {
	getThreadAnswerEntries,
	getUnnamedReplies,
	toCommentVersion,
} from './reply-answer.helper'

const WRITER = { __typename: 'User', login: 'Writer' } as const
const TIME = '2026-01-01T12:00:00Z'
const JOB_TOKEN_OWNED = {
	current: GITHUB_ACTIONS_IDENTITY,
	identities: [GITHUB_ACTIONS_IDENTITY],
} as const

describe('reply answer versions', () => {
	test('uses the edit time and requires an id and a time', () => {
		expect(
			toCommentVersion(
				threadReply({
					databaseId: 42,
					createdAt: TIME,
					lastEditedAt: '2026-01-02T12:00:00Z',
				})
			)
		).toMatchObject({ id: 42, at: '2026-01-02T12:00:00Z' })
		expect(
			toCommentVersion(threadReply({ databaseId: null, createdAt: TIME }))
		).toBeUndefined()
		expect(toCommentVersion(threadReply())).toBeUndefined()
	})
	test('a later app answer does not hide an older edited reply', () => {
		const reply = threadReply({
			databaseId: 42,
			body: 'confirmed',
			createdAt: TIME,
			author: WRITER,
		})
		const entry = toAnswerEntry(7, 'converse', [
			{ id: 42, at: TIME, body: reply.body },
		])
		const answer = threadReply({
			databaseId: 50,
			createdAt: '2026-01-02T12:00:00Z',
			body: toMarkerComment('reply', {
				v: 1,
				action: 'seen',
				reply: 42,
				commit: 'head',
				answers: entry ? [entry] : [],
			}),
		})
		expect(
			getUnnamedReplies([reply, answer], JOB_TOKEN_OWNED, new Set(['writer']))
		).toEqual([])
		expect(
			getUnnamedReplies(
				[
					{
						...reply,
						lastEditedAt: '2026-01-03T12:00:00Z',
						body: 'confirmed.',
					},
					answer,
				],
				JOB_TOKEN_OWNED,
				new Set(['writer'])
			)
		).toMatchObject([{ id: 42, body: 'confirmed.' }])
		expect(
			getThreadAnswerEntries(
				[{ ...answer, editor: WRITER }],
				GITHUB_ACTIONS_IDENTITY,
				{ at: '1970-01-01T00:00:00Z' }
			)
		).toEqual([])
	})
	test('names every unnamed writer reply in the read, excluding bots, outsiders and pasted markers', () => {
		const comments = [
			threadReply({
				databaseId: 1,
				body: 'first',
				createdAt: TIME,
				author: WRITER,
			}),
			threadReply({
				databaseId: 2,
				body: 'second',
				createdAt: TIME,
				author: WRITER,
			}),
			threadReply({ databaseId: 3, createdAt: TIME }),
			threadReply({
				databaseId: 4,
				createdAt: TIME,
				author: { __typename: 'User', login: 'outsider' },
			}),
			threadReply({
				databaseId: 5,
				createdAt: TIME,
				author: WRITER,
				body: toMarkerComment('reply', {
					v: 1,
					action: 'seen',
					reply: 1,
					commit: 'head',
				}),
			}),
		]
		expect(
			getUnnamedReplies(comments, JOB_TOKEN_OWNED, new Set(['writer']))
		).toMatchObject([{ id: 1 }, { id: 2 }])
	})
	test("a previous identity's answer names nothing, and its comments are still no replies", () => {
		const reply = threadReply({
			databaseId: 42,
			body: 'confirmed',
			createdAt: TIME,
			author: WRITER,
		})
		const entry = toAnswerEntry(7, 'converse', [
			{ id: 42, at: TIME, body: reply.body },
		])
		const answer = threadReply({
			databaseId: 50,
			createdAt: '2026-01-02T12:00:00Z',
			body: toMarkerComment('reply', {
				v: 1,
				action: 'seen',
				reply: 42,
				commit: 'head',
				answers: entry ? [entry] : [],
			}),
		})
		const owned = { current: APP_IDENTITY, identities: APP_MODE_IDENTITIES }
		expect(
			getUnnamedReplies([reply, answer], owned, new Set(['writer'])).map(
				version => version.id
			)
		).toEqual([42])
		expect(
			getThreadAnswerEntries([answer], APP_IDENTITY, { at: TIME })
		).toEqual([])
	})
})
