import { layer } from '@effect/vitest'
import { Deferred, Duration, Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import {
	COMMAND_PULL_REQUEST,
	COMMAND_COMMENT,
} from '../shared/mocks/github-api-fake.helper'
import {
	failGitHubTransport,
	getGitHubRequestBody,
	GITHUB_CREDENTIAL,
	GITHUB_SETTINGS,
	ISSUE_COMMENT,
	makeGitHubHttp,
	REVIEW_THREAD,
	toGitHubPage,
} from '../shared/mocks/github-http.helper'
import { botClosedReviewThread } from '../shared/mocks/publish-test.helper'
import { ownerReviewThread } from '../shared/mocks/thread-reply-test.helper'
import {
	API_VERSION,
	MAX_PAGES,
	PAGE_SIZE,
	PULL_REQUEST_COMMENTS_QUERY,
	REVIEW_THREADS_QUERY,
	READ_RETRIES,
	RECENT_COMMENTS,
	REPLY_TO_THREAD_MUTATION,
	RESOLVE_THREAD_MUTATION,
	REQUEST_TIMEOUT,
} from './github-api.constants'
import { GitHubApiService } from './github-api.service'
import { GitHubApiError } from './github.errors'

type GitHubRead = Effect.Effect<readonly unknown[], GitHubApiError>
type GitHubWrite = Effect.Effect<number | void, GitHubApiError>

const READS = [
	{
		operation: 'listReviewThreads',
		connection: 'reviewThreads',
		node: REVIEW_THREAD,
	},
	{ operation: 'listComments', connection: 'comments', node: ISSUE_COMMENT },
] as const
const WRITES = [
	{
		operation: 'createReviewComment',
		invoke: (service: GitHubApiService['Service']) =>
			service.createReviewComment(42, {
				commitId: 'abcdef1234567',
				path: 'src/one.ts',
				line: 7,
				body: 'Inline finding',
			}),
		method: 'POST',
		path: '/pulls/42/comments',
		body: {
			commit_id: 'abcdef1234567',
			path: 'src/one.ts',
			line: 7,
			side: 'RIGHT',
			body: 'Inline finding',
		},
	},
	{
		operation: 'createReviewComment',
		invoke: (service: GitHubApiService['Service']) =>
			service.createReviewComment(42, {
				commitId: 'abcdef1234567',
				path: 'src/one.ts',
				body: 'File finding',
			}),
		method: 'POST',
		path: '/pulls/42/comments',
		body: {
			commit_id: 'abcdef1234567',
			path: 'src/one.ts',
			subject_type: 'file',
			body: 'File finding',
		},
	},
	{
		operation: 'createIssueComment',
		invoke: (service: GitHubApiService['Service']) =>
			service.createIssueComment(42, 'Summary'),
		method: 'POST',
		path: '/issues/42/comments',
		body: { body: 'Summary' },
	},
	{
		operation: 'updateIssueComment',
		invoke: (service: GitHubApiService['Service']) =>
			service.updateIssueComment(17, 'Updated summary'),
		method: 'PATCH',
		path: '/issues/comments/17',
		body: { body: 'Updated summary' },
	},
] as const

/** Every operation uses the configured credentials and the versioned GitHub JSON contract. */
function expectHeaders(fixture: ReturnType<typeof makeGitHubHttp>) {
	for (const request of fixture.requests)
		expect(request.headers).toMatchObject({
			authorization: `Bearer ${GITHUB_CREDENTIAL}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': API_VERSION,
			'user-agent': 'mng-review',
		})
}

/** Errors retain their operation while excluding the credential from printable diagnostics. */
function expectApiFailure(failure: GitHubApiError, operation: string) {
	expect(failure).toBeInstanceOf(GitHubApiError)
	expect(failure.operation).toBe(operation)
	expect(failure.message).toContain(operation)
	expect(failure.message).not.toContain(GITHUB_CREDENTIAL)
	expect(JSON.stringify(failure)).not.toContain(GITHUB_CREDENTIAL)
}

layer(Layer.empty)('GitHubApiService reads', test => {
	test.effect(
		'requests and preserves the ten latest comments in chronological order',
		() =>
			Effect.gen(function* () {
				const thread = ownerReviewThread(RECENT_COMMENTS - 1)
				const fixture = makeGitHubHttp(() =>
					Effect.succeed(Response.json(toGitHubPage('reviewThreads', [thread])))
				)
				const threads = yield* GitHubApiService.use(service =>
					service.listReviewThreads(42)
				).pipe(Effect.provide(fixture.layer))
				expect(threads).toEqual([thread])
				expect(threads[0]?.latest?.nodes).toHaveLength(10)
				expect(getGitHubRequestBody(fixture.requests[0])).toMatchObject({
					query: REVIEW_THREADS_QUERY,
				})
				expect(REVIEW_THREADS_QUERY).toContain('latest: comments(last: 10)')
			})
	)

	for (const { label, latest } of [
		{ label: 'missing', latest: undefined },
		{ label: 'empty', latest: { nodes: [] } },
		{ label: 'closing reply', latest: botClosedReviewThread().latest },
	])
		test.effect(
			`review threads preserve optional latest comment: ${label}`,
			() =>
				Effect.gen(function* () {
					const thread = {
						...REVIEW_THREAD,
						...(latest === undefined ? {} : { latest }),
					}
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(
							Response.json(toGitHubPage('reviewThreads', [thread]))
						)
					)
					expect(
						yield* GitHubApiService.use(service =>
							service.listReviewThreads(42)
						).pipe(Effect.provide(fixture.layer))
					).toEqual([thread])
					expect(getGitHubRequestBody(fixture.requests[0])).toMatchObject({
						query: REVIEW_THREADS_QUERY,
					})
					expect(REVIEW_THREADS_QUERY).toMatch(
						new RegExp(
							String.raw`latest:\s*comments\(last: ${RECENT_COMMENTS}\)\s*\{\s*nodes\s*\{\s*databaseId body createdAt lastEditedAt author \{ __typename login \} editor \{ __typename login \} originalCommit \{ oid \}`,
							'u'
						)
					)
				})
		)

	for (const { operation, connection, node } of READS) {
		test.effect(
			`${operation} follows cursors, skips null nodes and preserves comment metadata`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp((_request, attempt) =>
						Effect.succeed(
							Response.json(
								attempt === 1
									? toGitHubPage(connection, [null, node], true, 'cursor-1')
									: toGitHubPage(connection, [node, null])
							)
						)
					)
					expect(
						yield* GitHubApiService.use((service): GitHubRead =>
							service[operation](42)
						).pipe(Effect.provide(fixture.layer))
					).toEqual([node, node])
					expect(fixture.requests).toHaveLength(2)
					for (const [index, request] of fixture.requests.entries()) {
						expect(request).toMatchObject({
							method: 'POST',
							url: GITHUB_SETTINGS.graphqlUrl,
						})
						expect(getGitHubRequestBody(request)).toMatchObject({
							query:
								connection === 'reviewThreads'
									? REVIEW_THREADS_QUERY
									: PULL_REQUEST_COMMENTS_QUERY,
							variables: {
								owner: GITHUB_SETTINGS.owner,
								name: GITHUB_SETTINGS.name,
								number: 42,
								cursor: index === 0 ? null : 'cursor-1',
							},
						})
					}
					expect(
						connection === 'reviewThreads'
							? REVIEW_THREADS_QUERY
							: PULL_REQUEST_COMMENTS_QUERY
					).toContain(`${connection}(first: ${PAGE_SIZE}, after: $cursor)`)
					expect(
						connection === 'reviewThreads'
							? REVIEW_THREADS_QUERY
							: PULL_REQUEST_COMMENTS_QUERY
					).toMatch(/editor\s*\{\s*__typename\s+login\s*\}/u)
					expectHeaders(fixture)
				})
		)
		test.effect(`${operation} accepts an empty connection`, () =>
			Effect.gen(function* () {
				const fixture = makeGitHubHttp(() =>
					Effect.succeed(Response.json(toGitHubPage(connection, [])))
				)
				expect(
					yield* GitHubApiService.use((service): GitHubRead =>
						service[operation](42)
					).pipe(Effect.provide(fixture.layer))
				).toEqual([])
				expect(fixture.requests).toHaveLength(1)
			})
		)
		for (const withData of [false, true])
			test.effect(
				`${operation} rejects GraphQL errors ${withData ? 'beside data' : 'without data'}`,
				() =>
					Effect.gen(function* () {
						const fixture = makeGitHubHttp(() =>
							Effect.succeed(
								Response.json({
									...(withData ? toGitHubPage(connection, [node]) : {}),
									errors: [
										{ message: 'Resource unavailable' },
										{ message: 'Field denied' },
									],
								})
							)
						)
						const pending = yield* GitHubApiService.use((service): GitHubRead =>
							service[operation](42)
						).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild)
						yield* TestClock.adjust('10 seconds')
						const failure = yield* Fiber.join(pending)
						expectApiFailure(failure, operation)
						expect(failure.reason).toBe('Resource unavailable; Field denied')
						expect(fixture.requests).toHaveLength(READ_RETRIES + 1)
					})
			)
		for (const data of [
			null,
			{ repository: null },
			{ repository: { pullRequest: null } },
		])
			test.effect(
				`${operation} rejects missing data ${JSON.stringify(data)}`,
				() =>
					Effect.gen(function* () {
						const fixture = makeGitHubHttp(() =>
							Effect.succeed(Response.json({ data }))
						)
						const failure = yield* GitHubApiService.use((service): GitHubRead =>
							service[operation](42)
						).pipe(Effect.provide(fixture.layer), Effect.flip)
						expectApiFailure(failure, operation)
						expect(failure.reason).toContain('repository or pull request')
						expect(fixture.requests).toHaveLength(1)
					})
			)
		for (const hasMore of [false, true])
			test.effect(
				`${operation} ${hasMore ? 'fails without a partial list past' : 'accepts exactly'} MAX_PAGES`,
				() =>
					Effect.gen(function* () {
						const fixture = makeGitHubHttp((_request, attempt) =>
							Effect.succeed(
								Response.json(
									toGitHubPage(
										connection,
										[node],
										hasMore || attempt < MAX_PAGES,
										`cursor-${attempt}`
									)
								)
							)
						)
						const read = GitHubApiService.use((service): GitHubRead =>
							service[operation](42)
						).pipe(Effect.provide(fixture.layer))
						if (hasMore) {
							const failure = yield* read.pipe(Effect.flip)
							expectApiFailure(failure, operation)
							expect(failure.reason).toContain(String(MAX_PAGES * PAGE_SIZE))
						} else
							expect(yield* read).toEqual(
								Array.from({ length: MAX_PAGES }, () => node)
							)
						expect(fixture.requests).toHaveLength(MAX_PAGES)
					})
			)
		for (const status of [400, 401, 403, 404, 422, 429])
			test.effect(
				`${operation} never retries HTTP ${status} and keeps GitHub's message`,
				() =>
					Effect.gen(function* () {
						const fixture = makeGitHubHttp(() =>
							Effect.succeed(
								Response.json({ message: 'Request denied' }, { status })
							)
						)
						const failure = yield* GitHubApiService.use((service): GitHubRead =>
							service[operation](42)
						).pipe(Effect.provide(fixture.layer), Effect.flip)
						expectApiFailure(failure, operation)
						expect(failure).toMatchObject({ status, reason: 'Request denied' })
						expect(failure.message).toContain(String(status))
						expect(fixture.requests).toHaveLength(1)
					})
			)
		test.effect(
			`${operation} rejects malformed successful answers after bounded retries`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(Response.json({ data: { repository: 'invalid' } }))
					)
					const pending = yield* GitHubApiService.use((service): GitHubRead =>
						service[operation](42)
					).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild)
					yield* TestClock.adjust('10 seconds')
					const failure = yield* Fiber.join(pending)
					expectApiFailure(failure, operation)
					expect(failure.reason).toBe('unexpected answer')
					expect(fixture.requests).toHaveLength(READ_RETRIES + 1)
				})
		)
		test.effect(
			`${operation} bounds retries of a hung request with REQUEST_TIMEOUT`,
			() =>
				Effect.gen(function* () {
					const started = yield* Deferred.make<void>()
					const interruptions: number[] = []
					const fixture = makeGitHubHttp((_request, attempt) =>
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.onInterrupt(() =>
								Effect.sync(() => {
									interruptions.push(attempt)
								})
							)
						)
					)
					const pending = yield* GitHubApiService.use((service): GitHubRead =>
						service[operation](42)
					).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild)
					yield* Deferred.await(started)
					yield* TestClock.adjust(Duration.toMillis(REQUEST_TIMEOUT) - 1)
					expect(interruptions).toEqual([])
					expect(fixture.requests).toHaveLength(1)
					yield* TestClock.adjust(1)
					expect(interruptions).toEqual([1])
					yield* TestClock.adjust(
						Duration.toMillis(REQUEST_TIMEOUT) * READ_RETRIES + 10_000
					)
					const failure = yield* Fiber.join(pending)
					expectApiFailure(failure, operation)
					expect(failure.reason).toContain(Duration.format(REQUEST_TIMEOUT))
					expect(fixture.requests).toHaveLength(READ_RETRIES + 1)
					expect(interruptions).toHaveLength(READ_RETRIES + 1)
				})
		)
		test.effect(
			`${operation} fails rather than returning a partial list when the next cursor is missing`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(
							Response.json(toGitHubPage(connection, [node], true, null))
						)
					)
					const outcome = yield* GitHubApiService.use((service): GitHubRead =>
						service[operation](42)
					).pipe(Effect.provide(fixture.layer), Effect.result)
					expect(outcome._tag).toBe('Failure')
					if (outcome._tag === 'Failure')
						expectApiFailure(outcome.failure, operation)
					expect(fixture.requests).toHaveLength(1)
				})
		)

		for (const transient of ['transport', 'server'] as const)
			for (const recovers of [false, true])
				test.effect(
					`${operation} ${recovers ? 'recovers after' : 'stops after'} READ_RETRIES ${transient} failures`,
					() =>
						Effect.gen(function* () {
							const fixture = makeGitHubHttp((request, attempt) => {
								if (recovers && attempt > READ_RETRIES)
									return Effect.succeed(
										Response.json(toGitHubPage(connection, [node]))
									)
								return transient === 'transport'
									? failGitHubTransport(request)
									: Effect.succeed(
											Response.json(
												{ message: 'Service unavailable' },
												{ status: 503 }
											)
										)
							})
							const pending = yield* GitHubApiService.use(
								(service): GitHubRead => service[operation](42)
							).pipe(
								Effect.provide(fixture.layer),
								Effect.result,
								Effect.forkChild
							)
							yield* TestClock.adjust('10 seconds')
							const outcome = yield* Fiber.join(pending)
							if (recovers)
								expect(outcome).toMatchObject({
									_tag: 'Success',
									success: [node],
								})
							else {
								expect(outcome._tag).toBe('Failure')
								if (outcome._tag === 'Failure')
									expectApiFailure(outcome.failure, operation)
							}
							expect(fixture.requests).toHaveLength(READ_RETRIES + 1)
							expectHeaders(fixture)
						})
				)
	}
})

layer(Layer.empty)('GitHubApiService writes', test => {
	for (const [index, write] of WRITES.entries()) {
		test.effect(
			`${write.operation} payload ${index} uses the REST path and returns its documented value`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(Response.json({ id: 91 }, { status: 201 }))
					)
					expect(
						yield* GitHubApiService.use((service): GitHubWrite =>
							write.invoke(service)
						).pipe(Effect.provide(fixture.layer))
					).toBe(write.operation === 'updateIssueComment' ? undefined : 91)
					expect(fixture.requests).toHaveLength(1)
					expect(fixture.requests[0]).toMatchObject({
						method: write.method,
						url: `${GITHUB_SETTINGS.apiUrl}/repos/${GITHUB_SETTINGS.owner}/${GITHUB_SETTINGS.name}${write.path}`,
					})
					expect(getGitHubRequestBody(fixture.requests[0])).toEqual(write.body)
					expectHeaders(fixture)
				})
		)
		for (const failureKind of [
			'transport',
			'server',
			'schema',
			'json',
		] as const)
			test.effect(
				`${write.operation} payload ${index} never retries ${failureKind} failures`,
				() =>
					Effect.gen(function* () {
						const fixture = makeGitHubHttp(request => {
							if (failureKind === 'transport')
								return failGitHubTransport(request)
							if (failureKind === 'server')
								return Effect.succeed(
									Response.json({ message: 'Server failed' }, { status: 502 })
								)
							if (failureKind === 'json')
								return Effect.succeed(new Response('invalid json'))
							return Effect.succeed(Response.json({ id: 'invalid-id' }))
						})
						const failure = yield* GitHubApiService.use(
							(service): GitHubWrite => write.invoke(service)
						).pipe(Effect.provide(fixture.layer), Effect.flip)
						expectApiFailure(failure, write.operation)
						if (failureKind === 'schema' || failureKind === 'json')
							expect(failure.reason).toBe('unexpected answer')
						if (failureKind === 'server')
							expect(failure).toMatchObject({
								status: 502,
								reason: 'Server failed',
							})
						expect(fixture.requests).toHaveLength(1)
					})
			)
		test.effect(
			`${write.operation} payload ${index} times out and interrupts a hung request without retrying`,
			() =>
				Effect.gen(function* () {
					const started = yield* Deferred.make<void>()
					const interrupted = yield* Deferred.make<void>()
					const fixture = makeGitHubHttp(() =>
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
						)
					)
					const pending = yield* GitHubApiService.use((service): GitHubWrite =>
						write.invoke(service)
					).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild)
					yield* Deferred.await(started)
					yield* TestClock.adjust(Duration.toMillis(REQUEST_TIMEOUT) - 1)
					expect(yield* Deferred.isDone(interrupted)).toBe(false)
					yield* TestClock.adjust(1)
					const failure = yield* Fiber.join(pending)
					expectApiFailure(failure, write.operation)
					expect(failure.reason).toContain(Duration.format(REQUEST_TIMEOUT))
					expect(yield* Deferred.isDone(interrupted)).toBe(true)
					expect(fixture.requests).toHaveLength(1)
				})
		)
	}
	for (const errorKind of ['REST', 'GraphQL'] as const)
		test.effect(
			`redacts the credential when ${errorKind} returns it in an error message`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(
							Response.json(
								errorKind === 'REST'
									? { message: `Denied credential ${GITHUB_CREDENTIAL}` }
									: {
											errors: [
												{ message: `Denied credential ${GITHUB_CREDENTIAL}` },
											],
										},
								{ status: errorKind === 'REST' ? 403 : 200 }
							)
						)
					)
					const pending = yield* GitHubApiService.use(
						(
							service
						): Effect.Effect<
							number | void | readonly unknown[],
							GitHubApiError
						> =>
							errorKind === 'REST'
								? service.createIssueComment(42, 'Summary')
								: service.listComments(42)
					).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild)
					yield* TestClock.adjust('10 seconds')
					const failure = yield* Fiber.join(pending)
					expectApiFailure(
						failure,
						errorKind === 'REST' ? 'createIssueComment' : 'listComments'
					)
				})
		)
	test.effect('includes response body decoding in REQUEST_TIMEOUT', () =>
		Effect.gen(function* () {
			const reading = yield* Deferred.make<void>()
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"id":'))
				},
			})
			const fixture = makeGitHubHttp(() =>
				Deferred.succeed(reading, undefined).pipe(
					Effect.as(new Response(stream))
				)
			)
			const pending = yield* GitHubApiService.use(service =>
				service.createIssueComment(42, 'Summary')
			).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild)
			yield* Deferred.await(reading)
			yield* TestClock.adjust(REQUEST_TIMEOUT)
			const failure = yield* Fiber.join(pending)
			expectApiFailure(failure, 'createIssueComment')
			expect(failure.reason).toContain(Duration.format(REQUEST_TIMEOUT))
			expect(fixture.requests).toHaveLength(1)
		})
	)

	test.effect(
		'discards unparseable HTTP error bodies while retaining status',
		() =>
			Effect.gen(function* () {
				const fixture = makeGitHubHttp(() =>
					Effect.succeed(new Response('not json', { status: 403 }))
				)
				const failure = yield* GitHubApiService.use(service =>
					service.createIssueComment(42, 'Summary')
				).pipe(Effect.provide(fixture.layer), Effect.flip)
				expectApiFailure(failure, 'createIssueComment')
				expect(failure).toMatchObject({ status: 403, reason: 'no message' })
			})
	)
})

layer(Layer.empty)('GitHubApiService thread mutations', test => {
	for (const operation of ['replyToThread', 'resolveThread'] as const) {
		test.effect(
			`${operation} sends the GraphQL mutation and thread node id`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(Response.json({ data: {} }))
					)
					yield* GitHubApiService.use(service =>
						operation === 'replyToThread'
							? service.replyToThread('thread-node', 'Resolution reason')
							: service.resolveThread('thread-node')
					).pipe(Effect.provide(fixture.layer))
					expect(fixture.requests).toHaveLength(1)
					expect(fixture.requests[0]).toMatchObject({
						method: 'POST',
						url: GITHUB_SETTINGS.graphqlUrl,
					})
					expect(getGitHubRequestBody(fixture.requests[0])).toEqual({
						query:
							operation === 'replyToThread'
								? REPLY_TO_THREAD_MUTATION
								: RESOLVE_THREAD_MUTATION,
						variables:
							operation === 'replyToThread'
								? { thread: 'thread-node', body: 'Resolution reason' }
								: { thread: 'thread-node' },
					})
				})
		)
		test.effect(
			`${operation} rejects GraphQL errors without retrying a write`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(Response.json({ errors: [{ message: 'Denied' }] }))
					)
					const failure = yield* GitHubApiService.use(service =>
						operation === 'replyToThread'
							? service.replyToThread('thread-node', 'Resolution reason')
							: service.resolveThread('thread-node')
					).pipe(Effect.provide(fixture.layer), Effect.flip)
					expect(failure.reason).toBe('Denied')
					expect(fixture.requests).toHaveLength(1)
				})
		)
	}
})

/** The three REST reads added below the manual-run trigger. */
const MANUAL_READS = [
	{
		operation: 'getPullRequest',
		invoke: (service: GitHubApiService['Service']) =>
			service.getPullRequest(17),
		path: '/pulls/17',
		answer: COMMAND_PULL_REQUEST,
		expected: COMMAND_PULL_REQUEST,
		invalid: {
			...COMMAND_PULL_REQUEST,
			head: { ...COMMAND_PULL_REQUEST.head, sha: 42 },
		},
	},
	{
		operation: 'getIssueComment',
		invoke: (service: GitHubApiService['Service']) =>
			service.getIssueComment(23),
		path: '/issues/comments/23',
		answer: COMMAND_COMMENT,
		expected: COMMAND_COMMENT,
		invalid: { ...COMMAND_COMMENT, user: { login: 42, type: 'User' } },
	},
	{
		operation: 'getCollaboratorRole',
		invoke: (service: GitHubApiService['Service']) =>
			service.getCollaboratorRole('review helper/@name?#'),
		path: '/collaborators/review%20helper%2F%40name%3F%23/permission',
		answer: { role_name: 'write', permission: 'write' },
		expected: { role_name: 'write', permission: 'write' },
		invalid: { role_name: 42 },
	},
] as const

type ManualRead = Effect.Effect<unknown, GitHubApiError>

layer(Layer.empty)('GitHubApiService manual REST reads', test => {
	for (const read of MANUAL_READS) {
		test.effect(
			`${read.operation} uses its REST path and decodes the response`,
			() =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp(() =>
						Effect.succeed(Response.json(read.answer))
					)
					expect(
						yield* GitHubApiService.use((service): ManualRead =>
							read.invoke(service)
						).pipe(Effect.provide(fixture.layer))
					).toEqual(read.expected)
					expect(fixture.requests).toHaveLength(1)
					expect(fixture.requests[0]).toMatchObject({
						method: 'GET',
						url: `${GITHUB_SETTINGS.apiUrl}/repos/${GITHUB_SETTINGS.owner}/${GITHUB_SETTINGS.name}${read.path}`,
					})
					expectHeaders(fixture)
				})
		)
		for (const transient of ['transport', 'server'] as const)
			test.effect(`${read.operation} retries one ${transient} failure`, () =>
				Effect.gen(function* () {
					const fixture = makeGitHubHttp((request, attempt) => {
						if (attempt > 1) return Effect.succeed(Response.json(read.answer))
						return transient === 'transport'
							? failGitHubTransport(request)
							: Effect.succeed(
									Response.json({ message: 'Unavailable' }, { status: 503 })
								)
					})
					const pending = yield* GitHubApiService.use((service): ManualRead =>
						read.invoke(service)
					).pipe(Effect.provide(fixture.layer), Effect.forkChild)
					yield* TestClock.adjust('10 seconds')
					expect(yield* Fiber.join(pending)).toEqual(read.expected)
					expect(fixture.requests).toHaveLength(2)
					expect(
						fixture.requests.every(request => request.url.endsWith(read.path))
					).toBe(true)
				})
			)
		for (const answer of [null, {}, read.invalid])
			test.effect(
				`${read.operation} rejects invalid schema ${JSON.stringify(answer)}`,
				() =>
					Effect.gen(function* () {
						const fixture = makeGitHubHttp(() =>
							Effect.succeed(Response.json(answer))
						)
						const pending = yield* GitHubApiService.use((service): ManualRead =>
							read.invoke(service)
						).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild)
						yield* TestClock.adjust('10 seconds')
						const failure = yield* Fiber.join(pending)
						expectApiFailure(failure, read.operation)
						expect(failure.reason).toBe('unexpected answer')
						expect(fixture.requests).toHaveLength(READ_RETRIES + 1)
					})
			)
	}
	for (const read of MANUAL_READS.slice(0, 2))
		test.effect(`${read.operation} accepts nullable metadata`, () =>
			Effect.gen(function* () {
				const answer = { ...read.answer, body: null, user: null }
				const fixture = makeGitHubHttp(() =>
					Effect.succeed(Response.json(answer))
				)
				expect(
					yield* GitHubApiService.use((service): ManualRead =>
						read.invoke(service)
					).pipe(Effect.provide(fixture.layer))
				).toEqual(answer)
			})
		)
})
