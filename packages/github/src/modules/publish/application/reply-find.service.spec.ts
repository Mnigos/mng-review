import { layer } from '@effect/vitest'
import { Effect, Layer, ConfigProvider } from 'effect'
import { RECENT_COMMENTS } from '../../../platform/github-api.constants'
import type { OpenPullRequest } from '../../../platform/github-api.schema'
import { GitHubReadConfigLive } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	githubStatusFake,
	openPullRequest,
} from '../../../shared/mocks/github-status-fake.helper'
import {
	TOKEN_MODE_OWNED,
	appSummary,
	SUMMARY_MARKER,
	reviewThread,
	threadReply,
} from '../../../shared/mocks/publish-test.helper'
import {
	pendingReviewThread,
	markedThreadReply,
	ownerReviewThread,
} from '../../../shared/mocks/thread-reply-test.helper'
import { MAX_REPLY_THREADS } from '../domain/publish.constants'
import { ReplyFindService, ReplyFindServiceLive } from './reply-find.service'
import { SummaryReviewServiceLive } from './summary-review.service'

/** A different reply on each pull request, with IDs independent of pull request order. */
function setup(
	pulls: readonly OpenPullRequest[],
	commentIds: readonly number[] = []
) {
	const fake = githubApiFake()
	fake.command.role = 'write'
	const threads = pulls.map((pr, index) => {
		const thread = pendingReviewThread({ id: `thread-${pr.number}` })
		return {
			...thread,
			latest: {
				nodes: (thread.latest?.nodes ?? []).map(comment => ({
					...comment,
					databaseId: commentIds[index] ?? pr.number,
				})),
			},
		}
	})
	fake.threads.push(...threads)
	fake.threadSnapshots.push(...threads.map(thread => [thread]))
	const status = githubStatusFake({
		listOpenPullRequests: () => Effect.succeed(pulls),
	})
	const service = ReplyFindServiceLive.pipe(
		Layer.provide(SummaryReviewServiceLive),
		Layer.provide(
			Layer.mergeAll(
				fake.api,
				status.layer,
				GitHubReadConfigLive.pipe(
					Layer.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnvRecord({
								GITHUB_REPOSITORY: 'example/project',
								GITHUB_TOKEN: 'fixture',
							})
						)
					)
				)
			)
		)
	)
	return { fake, status, service }
}

layer(TOKEN_MODE_OWNED)('ReplyFindService', test => {
	for (const marked of [false, true])
		test.effect(
			`a quiet latest comment with human bot marker=${marked} reads no summaries or roles`,
			() =>
				Effect.gen(function* () {
					const fixture = setup([openPullRequest(17, 'a'.repeat(40))])
					const thread = pendingReviewThread({
						latest: {
							nodes: [
								markedThreadReply(
									'disputed',
									marked
										? { author: { __typename: 'User', login: 'contributor' } }
										: {}
								),
							],
						},
					})
					fixture.fake.threads.splice(0, 1, thread)
					fixture.fake.threadSnapshots.splice(0, 1, [thread])
					expect(
						yield* ReplyFindService.use(service =>
							service.find({ max: 5, rotation: 0 })
						).pipe(Effect.provide(fixture.service))
					).toEqual({ candidates: [], read: 1, failed: 0 })
					expect(fixture.fake.threadReads).toEqual([17])
					expect(fixture.fake.commentReads).toEqual([])
					expect(fixture.fake.reads).toEqual([])
					expect(fixture.fake.writes).toEqual([])
				})
		)
	for (const source of [
		'hidden summary',
		'recent answer',
		'older answer',
	] as const)
		test.effect(`leaves out a reply waiting only through a ${source}`, () =>
			Effect.gen(function* () {
				const fixture = setup([openPullRequest(17, 'a'.repeat(40))])
				const thread =
					source === 'hidden summary'
						? pendingReviewThread({ id: 'thread-17' })
						: ownerReviewThread(
								source === 'older answer' ? RECENT_COMMENTS + 1 : 1,
								{ id: 'thread-17' }
							)
				fixture.fake.threads.splice(0, 1, thread)
				fixture.fake.threadSnapshots.splice(0, 1, [thread])
				if (source === 'hidden summary') {
					fixture.fake.comments.push(
						appSummary(
							{ ...SUMMARY_MARKER, needsOwner: [thread.id] },
							{
								isMinimized: true,
								author: { __typename: 'Bot', login: 'github-actions' },
							}
						),
						appSummary(SUMMARY_MARKER, {
							databaseId: 101,
							author: { __typename: 'Bot', login: 'github-actions' },
						})
					)
				}
				if (source === 'older answer') {
					expect(
						thread.latest?.nodes.some(comment =>
							comment.body.includes('needs-owner')
						)
					).toBe(false)
					fixture.fake.threadComments.set(thread.id, [
						...reviewThread().comments.nodes,
						markedThreadReply(),
						...(thread.latest?.nodes ?? []),
					])
				}
				expect(
					yield* ReplyFindService.use(service =>
						service.find({ max: 5, rotation: 0 })
					).pipe(Effect.provide(fixture.service))
				).toEqual({ candidates: [], read: 1, failed: 0 })
				if (source === 'hidden summary')
					expect(fixture.fake.commentReads).toEqual([17])
				if (source === 'older answer')
					expect(fixture.fake.reads).toContain(
						`listThreadComments:${thread.id}`
					)
				expect(
					fixture.fake.reads.filter(read =>
						read.startsWith('getCollaboratorRole:')
					)
				).toEqual([])
				expect(fixture.fake.writes).toEqual([])
			})
		)
	for (const failures of [0, 1, 2])
		test.effect(
			`counts ${failures} failed reads among eligible pull requests`,
			() =>
				Effect.gen(function* () {
					const fixture = setup([
						openPullRequest(17, 'a'.repeat(40)),
						openPullRequest(18, 'c'.repeat(40)),
						openPullRequest(19, 'd'.repeat(40), { draft: true }),
					])
					fixture.fake.failures.listThreads.push(
						...Array.from(
							{ length: failures },
							() =>
								new GitHubApiError({
									operation: 'listThreads',
									reason: 'unavailable',
									status: 503,
								})
						)
					)
					fixture.fake.threadSnapshots.splice(0, failures)
					expect(
						yield* ReplyFindService.use(service =>
							service.find({ max: 5, rotation: 0 })
						).pipe(Effect.provide(fixture.service))
					).toEqual({
						candidates: [17, 18].slice(failures).map(number => ({
							number,
							base: 'b'.repeat(40),
							head: (number === 17 ? 'a' : 'c').repeat(40),
						})),
						read: 2,
						failed: failures,
					})
					expect(fixture.fake.threadReads).toEqual([17, 18])
				})
		)
	test.effect(
		'no open pull request gives an empty list without any thread read',
		() =>
			Effect.gen(function* () {
				const fixture = setup([])
				expect(
					yield* ReplyFindService.use(service =>
						service
							.find({ max: 5, rotation: 0 })
							.pipe(Effect.map(found => found.candidates))
					).pipe(Effect.provide(fixture.service))
				).toEqual([])
				expect(fixture.fake.threadReads).toEqual([])
				expect(fixture.fake.writes).toEqual([])
			})
	)
	for (const excluded of ['fork', 'missing repository', 'draft'] as const)
		test.effect(
			`leaves out a ${excluded} pull request before reading its replies`,
			() =>
				Effect.gen(function* () {
					const pr = openPullRequest(17, 'a'.repeat(40))
					const excludedPr =
						excluded === 'draft'
							? { ...pr, draft: true }
							: {
									...pr,
									head: {
										...pr.head,
										repo:
											excluded === 'fork'
												? { full_name: 'example/fork' }
												: null,
									},
								}
					const fixture = setup([excludedPr])
					expect(
						yield* ReplyFindService.use(service =>
							service
								.find({ max: 5, rotation: 0 })
								.pipe(Effect.map(found => found.candidates))
						).pipe(Effect.provide(fixture.service))
					).toEqual([])
					expect(fixture.fake.threadReads).toEqual([])
				})
		)
	for (const role of ['read', 'triage'])
		test.effect(
			`a reply from a login with ${role} access cannot select a pull request`,
			() =>
				Effect.gen(function* () {
					const fixture = setup([openPullRequest(17, 'a'.repeat(40))])
					fixture.fake.command.role = role
					expect(
						yield* ReplyFindService.use(service =>
							service
								.find({ max: 5, rotation: 0 })
								.pipe(Effect.map(found => found.candidates))
						).pipe(Effect.provide(fixture.service))
					).toEqual([])
					expect(fixture.fake.reads).toContain(
						'getCollaboratorRole:contributor'
					)
					expect(fixture.fake.writes).toEqual([])
				})
		)
	test.effect(
		'six candidates give five in reply databaseId order, with safe matrix values',
		() =>
			Effect.gen(function* () {
				const pulls = Array.from({ length: 6 }, (_, index) =>
					openPullRequest(index + 1, 'a'.repeat(40))
				)
				const fixture = setup(pulls, [60, 10, 50, 20, 40, 30])
				const candidates = yield* ReplyFindService.use(service =>
					service
						.find({ max: 5, rotation: 0 })
						.pipe(Effect.map(found => found.candidates))
				).pipe(Effect.provide(fixture.service))
				expect(candidates.map(pr => pr.number)).toEqual([2, 4, 6, 5, 3])
				for (const candidate of candidates) {
					expect(Object.keys(candidate).toSorted()).toEqual([
						'base',
						'head',
						'number',
					])
					expect(Number.isSafeInteger(candidate.number)).toBe(true)
					expect(candidate.base).toMatch(/^[a-f\d]{40}$/iu)
					expect(candidate.head).toMatch(/^[a-f\d]{40}$/iu)
				}
				expect(fixture.fake.writes).toEqual([])
				expect(fixture.status.checks).toEqual([])
				expect(fixture.status.statuses).toEqual([])
			})
	)
	test.effect(
		'the next rotation reaches the sixth candidate instead of repeating the first batch',
		() =>
			Effect.gen(function* () {
				const fixture = setup(
					Array.from({ length: 6 }, (_, index) =>
						openPullRequest(index + 1, 'a'.repeat(40))
					)
				)
				expect(
					(yield* ReplyFindService.use(service =>
						service
							.find({ max: 5, rotation: 1 })
							.pipe(Effect.map(found => found.candidates))
					).pipe(Effect.provide(fixture.service))).map(pr => pr.number)
				).toEqual([6, 1, 2, 3, 4])
			})
	)
	for (const operation of ['listThreads', 'listComments'] as const)
		test.effect(
			`a GitHub ${operation} error skips only the affected pull request`,
			() =>
				Effect.gen(function* () {
					const fixture = setup([
						openPullRequest(17, 'a'.repeat(40)),
						openPullRequest(18, 'c'.repeat(40)),
					])
					fixture.fake.failures[operation].push(
						new GitHubApiError({
							operation,
							reason: 'unavailable',
							status: 503,
						})
					)
					if (operation === 'listThreads') fixture.fake.threadSnapshots.shift()
					expect(
						yield* ReplyFindService.use(service =>
							service
								.find({ max: 5, rotation: 0 })
								.pipe(Effect.map(found => found.candidates))
						).pipe(Effect.provide(fixture.service))
					).toEqual([
						{ number: 18, base: 'b'.repeat(40), head: 'c'.repeat(40) },
					])
					expect(fixture.fake.writes).toEqual([])
				})
		)
	for (const field of ['number', 'base', 'head'] as const)
		test.effect(
			`rejects an unsafe matrix ${field} before reading replies`,
			() =>
				Effect.gen(function* () {
					const pr = openPullRequest(17, 'a'.repeat(40))
					const invalid =
						field === 'number'
							? { ...pr, number: 1.5 }
							: { ...pr, [field]: { ...pr[field], sha: 'bad; echo injected' } }
					const fixture = setup([invalid])
					expect(
						yield* ReplyFindService.use(service =>
							service
								.find({ max: 5, rotation: 0 })
								.pipe(Effect.map(found => found.candidates))
						).pipe(Effect.provide(fixture.service))
					).toEqual([])
					expect(fixture.fake.threadReads).toEqual([])
				})
		)
})

layer(TOKEN_MODE_OWNED)(
	'ReplyFindService oldest reply across batches',
	test => {
		test.effect(
			'the oldest reply beyond the first thread batch still orders its pull request first',
			() =>
				Effect.gen(function* () {
					const fixture = setup(
						[
							openPullRequest(17, 'a'.repeat(40)),
							openPullRequest(18, 'c'.repeat(40)),
						],
						[100, 50]
					)
					const threads = Array.from(
						{ length: MAX_REPLY_THREADS + 1 },
						(_, index) => {
							const thread = pendingReviewThread({
								id: `first-pull-thread-${index}`,
							})
							return {
								...thread,
								latest: {
									nodes: (thread.latest?.nodes ?? []).map(comment => ({
										...comment,
										databaseId: index === MAX_REPLY_THREADS ? 10 : 100 + index,
									})),
								},
							}
						}
					)
					fixture.fake.threads.splice(0, 1, ...threads)
					fixture.fake.threadSnapshots.splice(0, 1, threads)
					expect(
						(yield* ReplyFindService.use(service =>
							service
								.find({ max: 1, rotation: 0 })
								.pipe(Effect.map(found => found.candidates))
						).pipe(Effect.provide(fixture.service))).map(pr => pr.number)
					).toEqual([17])
				})
		)
	}
)

layer(TOKEN_MODE_OWNED)('ReplyFindService named holds', test => {
	for (const resolved of [false, true])
		test.effect(
			`the converse reaches an unnamed older reply in a resolved=${resolved} thread`,
			() =>
				Effect.gen(function* () {
					const fixture = setup([openPullRequest(17, 'a'.repeat(40))])
					const thread = pendingReviewThread({
						isResolved: resolved,
						latest: {
							nodes: [
								markedThreadReply('disputed', {
									databaseId: 50,
									createdAt: '2026-01-02T12:00:00Z',
								}),
							],
						},
					})
					fixture.fake.threadSnapshots.splice(0, 1, [thread])
					fixture.fake.threadComments.set(thread.id, [
						threadReply({
							databaseId: 42,
							body: 'confirmed',
							createdAt: '2026-01-01T12:00:00Z',
							author: { __typename: 'User', login: 'contributor' },
						}),
						...(thread.latest?.nodes ?? []),
					])
					expect(
						(yield* ReplyFindService.use(service =>
							service.readPending({
								pullNumber: 17,
								rotation: 0,
								naming: true,
								...(resolved ? { held: 42 } : {}),
							})
						).pipe(Effect.provide(fixture.service))).replies
					).toMatchObject([{ commentId: 42, body: 'confirmed' }])
				})
		)
})
