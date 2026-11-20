import { layer } from '@effect/vitest'
import { ConfigError } from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import { parseIssueCommentEvent } from './issue-comment-event.parser'
import type { IssueCommentEventPayload } from './issue-comment-event.schema'

const PAYLOAD = {
	action: 'created',
	comment: {
		id: 23,
		body: '@mng-review review deep',
		user: { login: 'author-a', type: 'User' },
	},
	issue: {
		number: 17,
		pull_request: { url: 'https://api.example.test/pulls/17' },
	},
} as const satisfies IssueCommentEventPayload

layer(Layer.empty)('parseIssueCommentEvent', test => {
	test.effect(
		'reads comment identity, text, author and pull request number',
		() =>
			Effect.gen(function* () {
				expect(
					yield* parseIssueCommentEvent(
						JSON.stringify(PAYLOAD),
						'issue_comment'
					)
				).toEqual({
					eventName: 'issue_comment',
					action: 'created',
					id: 23,
					body: '@mng-review review deep',
					login: 'author-a',
					type: 'User',
					viaApp: false,
					issueNumber: 17,
					onPullRequest: true,
				})
			})
	)
	test.effect(
		'null body and user become empty strings for authorization to deny',
		() =>
			Effect.gen(function* () {
				expect(
					yield* parseIssueCommentEvent(
						JSON.stringify({
							...PAYLOAD,
							comment: { ...PAYLOAD.comment, body: null, user: null },
						}),
						'issue_comment'
					)
				).toMatchObject({ body: '', login: '', type: '' })
			})
	)
	for (const app of [undefined, null, { id: 7, slug: 'example-app' }])
		test.effect(`app ${JSON.stringify(app)} determines viaApp`, () =>
			Effect.gen(function* () {
				expect(
					yield* parseIssueCommentEvent(
						JSON.stringify({
							...PAYLOAD,
							comment: {
								...PAYLOAD.comment,
								...(app === undefined ? {} : { performed_via_github_app: app }),
							},
						}),
						'issue_comment'
					)
				).toHaveProperty('viaApp', app !== undefined && app !== null)
			})
		)
	for (const pullRequest of [undefined, null, {}])
		test.effect(
			`pull_request ${JSON.stringify(pullRequest)} determines onPullRequest`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* parseIssueCommentEvent(
							JSON.stringify({
								...PAYLOAD,
								issue: {
									number: 17,
									...(pullRequest === undefined
										? {}
										: { pull_request: pullRequest }),
								},
							}),
							'issue_comment'
						)
					).toHaveProperty(
						'onPullRequest',
						pullRequest !== undefined && pullRequest !== null
					)
				})
		)
	test.effect(
		'carries the event name and edited action without authorizing them',
		() =>
			Effect.gen(function* () {
				expect(
					yield* parseIssueCommentEvent(
						JSON.stringify({ ...PAYLOAD, action: 'edited' }),
						'other_event'
					)
				).toMatchObject({ eventName: 'other_event', action: 'edited' })
			})
	)
	for (const text of [
		'{',
		'{}',
		'null',
		'[]',
		JSON.stringify({ issue: PAYLOAD.issue }),
		JSON.stringify({ comment: PAYLOAD.comment, issue: PAYLOAD.issue }),
		JSON.stringify({ ...PAYLOAD, action: 42 }),
		JSON.stringify({ ...PAYLOAD, comment: { ...PAYLOAD.comment, id: '23' } }),
		JSON.stringify({ ...PAYLOAD, comment: { ...PAYLOAD.comment, body: 42 } }),
		JSON.stringify({
			...PAYLOAD,
			comment: { ...PAYLOAD.comment, user: { login: 'author-a' } },
		}),
		JSON.stringify({ ...PAYLOAD, issue: { number: '17' } }),
	])
		test.effect(`malformed event ${text} names GITHUB_EVENT_PATH`, () =>
			Effect.gen(function* () {
				const error = yield* parseIssueCommentEvent(text, 'issue_comment').pipe(
					Effect.flip
				)
				expect(error).toBeInstanceOf(ConfigError)
				expect(error.source).toBe('GITHUB_EVENT_PATH')
				expect(error.reason).toContain('not a comment event')
			})
		)
})
