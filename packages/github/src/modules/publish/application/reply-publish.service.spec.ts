import { layer } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { RECENT_COMMENTS } from '../../../platform/github-api.constants'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	githubStatusFake,
	openPullRequest,
} from '../../../shared/mocks/github-status-fake.helper'
import {
	ACCEPTING_RULES,
	summaryReview,
	SUMMARY_MARKER,
	RULES,
	TOKEN_MODE_OWNED,
	threadReply,
} from '../../../shared/mocks/publish-test.helper'
import {
	ACCEPTED_DECISION,
	decidedReply,
	longOwnerThreads,
	ownerReviewThread,
	pendingReviewThread,
	unsettledBugThread,
} from '../../../shared/mocks/thread-reply-test.helper'
import {
	RaiseService,
	RaiseServiceLive,
} from '../../status/application/raise.service'
import {
	StatusSweepService,
	StatusSweepServiceLive,
} from '../../status/application/status-sweep.service'
import {
	toCommitStatus,
	UNFINISHED_NOTE,
} from '../../status/domain/status.helper'
import { toBodyDigest, toBotThread } from '../domain/bot-thread.helper'
import {
	parseReplyMarker,
	parseSummaryMarker,
} from '../domain/publish-marker.parser'
import type { ThreadReplyDecision } from '../domain/thread-reply.schema'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import {
	ReplyPublishService,
	ReplyPublishServiceLive,
	type ReplyPublishInput,
} from './reply-publish.service'
import {
	SummaryReviewService,
	SummaryReviewServiceLive,
} from './summary-review.service'

const RESOLVED = {
	action: 'resolved',
	reason: 'The guard fixes it.',
} as const satisfies ThreadReplyDecision

/** Binds the shared pending conversation to a real finding commit. */
function threadAtCommit(commit: string) {
	const thread = pendingReviewThread()
	return {
		...thread,
		comments: {
			...thread.comments,
			nodes: thread.comments.nodes.map(comment => ({
				...comment,
				originalCommit: { oid: commit },
			})),
		},
	}
}

/** What the status boundary of a test does differently, such as a status write GitHub refuses. */
type StatusOverrides = Parameters<typeof githubStatusFake>[0]

/** Real local history and recording GitHub boundaries, with no model or HTTP layer. */
function setup(statusOverrides: StatusOverrides = {}) {
	const repo = createRepo()
	const original = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
	repo.write('src/store.ts', original)
	const base = repo.commit()
	repo.write('src/store.ts', original.replace('line 10\n', 'changed 10\n'))
	const head = repo.commit()
	const fake = githubApiFake()
	const status = githubStatusFake(statusOverrides)
	fake.reviews.push(
		summaryReview(
			{ ...SUMMARY_MARKER, head, finished: true },
			{ author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login } }
		)
	)
	const boundaries = Layer.mergeAll(
		fake.api,
		status.layer,
		gitLayer(repo.root),
		Layer.succeed(GitHubConfig, {
			serverUrl: 'https://github.com',
			apiUrl: 'https://api.github.com',
			graphqlUrl: 'https://api.github.com/graphql',
			owner: 'example',
			name: 'project',
			token: Redacted.make('fixture'),
			identity: GITHUB_ACTIONS_IDENTITY,
		})
	)
	const publisher = ReplyPublishServiceLive.pipe(
		Layer.provide(SummaryReviewServiceLive),
		Layer.provide(boundaries)
	)
	const summaries = SummaryReviewServiceLive.pipe(Layer.provide(boundaries))
	const input = {
		pullNumber: 17,
		head,
		engineCommit: 'engine',
		rules: ACCEPTING_RULES,
		replies: { base, tokens: {}, decisions: [] },
	} as const satisfies ReplyPublishInput
	return { repo, base, head, fake, status, publisher, summaries, input }
}

afterEach(cleanupRepos)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'ReplyPublishService independent git checks',
	test => {
		for (const touched of [false, true])
			test.effect(
				touched
					? 'answers resolved and closes the bug when a later commit touched its file'
					: 'drops forged resolved and keeps the bug open when only another file changed',
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.repo.write('unrelated.ts', 'another change\n')
						const head = fixture.repo.commit()
						fixture.fake.threads.push(
							threadAtCommit(touched ? fixture.base : fixture.head)
						)
						expect(
							yield* ReplyPublishService.use(service =>
								service.publish({
									...fixture.input,
									head,
									replies: {
										...fixture.input.replies,
										decisions: [decidedReply(RESOLVED)],
									},
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({
							answered: touched ? { resolved: 1 } : {},
							openBugs: touched ? 0 : 1,
						})
						const answers = fixture.fake.writes.filter(
							write => write.method === 'reply'
						)
						expect(answers).toHaveLength(touched ? 1 : 0)
						if (touched) expect(answers[0]?.body).toContain('No longer found')
						expect(
							fixture.fake.writes.filter(write => write.method === 'resolve')
						).toEqual(touched ? [{ method: 'resolve', id: 'thread' }] : [])
						expect(fixture.fake.threads[0]?.isResolved).toBe(touched)
					})
			)
		test.effect(
			'keeps a closed bug open when a person replied after the close and before the second read',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const thread = threadAtCommit(fixture.base)
					fixture.fake.threads.push(thread)
					// GitHub keeps the thread open; a person answers the bot's close before the reread.
					fixture.fake.failures.resolve.push(
						new GitHubApiError({
							operation: 'resolveThread',
							reason: 'Forbidden',
							status: 403,
						})
					)
					fixture.fake.threadSnapshots.push(
						[thread],
						[
							{
								...thread,
								comments: { ...thread.comments, totalCount: 4 },
								latest: {
									nodes: [
										{
											databaseId: 77,
											body: 'still broken on the second path',
											author: { __typename: 'User', login: 'contributor' },
											editor: null,
											originalCommit: null,
										},
									],
								},
							},
						]
					)
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish({
								...fixture.input,
								replies: {
									...fixture.input.replies,
									decisions: [decidedReply(RESOLVED)],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						answered: { resolved: 1 },
						openBugs: 1,
						verdict: 'needs fixes',
					})
					expect(fixture.fake.threadReads).toHaveLength(2)
					expect(
						fixture.status.statuses.filter(status => status.state === 'success')
					).toEqual([])
				})
		)
		for (const reread of [true, false])
			test.effect(
				reread
					? 'a closed bug the second read shows resolved counts closed and clears the change request'
					: 'a failed second read keeps the close it made and clears no change request',
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.reviews.splice(
							0,
							1,
							summaryReview(
								{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
								{
									state: 'CHANGES_REQUESTED',
									commit: { oid: fixture.head },
									author: {
										__typename: 'Bot',
										login: GITHUB_ACTIONS_IDENTITY.login,
									},
								}
							)
						)
						fixture.fake.command.pullRequest = {
							...fixture.fake.command.pullRequest,
							head: {
								...fixture.fake.command.pullRequest.head,
								sha: fixture.head,
							},
						}
						fixture.fake.threads.push(threadAtCommit(fixture.base))
						if (!reread)
							fixture.fake.failures.listThreads.push(
								undefined,
								new GitHubApiError({
									operation: 'threads',
									reason: 'unavailable',
								})
							)
						expect(
							yield* ReplyPublishService.use(service =>
								service.publish({
									...fixture.input,
									replies: {
										...fixture.input.replies,
										decisions: [decidedReply(RESOLVED)],
									},
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({
							answered: { resolved: 1 },
							openBugs: 0,
							verdict: 'ready',
							dismissal: { dismissed: reread ? 1 : 0, failed: 0 },
						})
						expect(fixture.fake.threadReads).toHaveLength(2)
						expect(
							fixture.fake.writes.filter(
								write => write.method === 'dismissReview'
							)
						).toHaveLength(reread ? 1 : 0)
					})
			)
		test.effect(
			'drops resolved and keeps the bug open when its commit is not an ancestor of the bound head',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.repo.git('checkout', '-b', 'divergent', fixture.base)
					fixture.repo.write('src/store.ts', 'divergent behavior\n')
					const divergent = fixture.repo.commit()
					fixture.fake.threads.push(threadAtCommit(divergent))
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish({
								...fixture.input,
								replies: {
									...fixture.input.replies,
									decisions: [decidedReply(RESOLVED)],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ answered: {}, openBugs: 1, verdict: 'needs fixes' })
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'reply' || write.method === 'resolve'
						)
					).toEqual([])
					expect(fixture.fake.threads[0]?.isResolved).toBe(false)
				})
		)
		for (const { name, evidence, accepted } of [
			{
				name: 'drops accepted and keeps the bug open when its only citation is a line added by the pull request',
				evidence: 'src/store.ts:10',
				accepted: false,
			},
			{
				name: 'drops accepted and keeps the bug open when its only citation is a missing path',
				evidence: 'missing.ts:1',
				accepted: false,
			},
			{
				name: 'answers accepted and closes the bug when its citation passes at the bound commits',
				evidence: 'src/store.ts:12',
				accepted: true,
			},
		] as const)
			test.effect(name, () =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push(threadAtCommit(fixture.base))
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish({
								...fixture.input,
								replies: {
									...fixture.input.replies,
									decisions: [
										decidedReply({
											...ACCEPTED_DECISION,
											evidence: [evidence],
										}),
									],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						answered: accepted ? { accepted: 1 } : {},
						openBugs: accepted ? 0 : 1,
						verdict: accepted ? 'ready' : 'needs fixes',
					})
					const answers = fixture.fake.writes.filter(
						write => write.method === 'reply'
					)
					expect(answers).toHaveLength(accepted ? 1 : 0)
					if (accepted) {
						expect(answers[0]?.body).toContain('Accepted as intentional')
						expect(answers[0]?.body).toContain('`src/store.ts:12`')
						expect(parseReplyMarker(answers[0]?.body ?? '')).toMatchObject({
							action: 'accepted',
							commit: fixture.head,
							reply: 42,
						})
					}
					expect(
						fixture.fake.writes.filter(write => write.method === 'resolve')
					).toEqual(accepted ? [{ method: 'resolve', id: 'thread' }] : [])
					expect(fixture.fake.threads[0]?.isResolved).toBe(accepted)
				})
			)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'ReplyPublishService summary failure',
	test => {
		for (const needsOwner of [false, true])
			test.effect(
				`a failed summary propagates and sets failure only with needs owner=${needsOwner}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.reviews.splice(
							0,
							1,
							summaryReview(
								{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
								{ state: 'CHANGES_REQUESTED', commit: { oid: fixture.head } }
							)
						)
						fixture.fake.command.role = 'write'
						fixture.fake.command.pullRequest = {
							...fixture.fake.command.pullRequest,
							head: {
								...fixture.fake.command.pullRequest.head,
								sha: fixture.head,
							},
						}
						fixture.fake.threads.push(threadAtCommit(fixture.base))
						const error = new GitHubApiError({
							operation: 'updateReview',
							reason: 'summary unavailable',
							status: 503,
						})
						fixture.fake.failures.updateReview.push(error)
						expect(
							yield* ReplyPublishService.use(service =>
								service.publish({
									...fixture.input,
									rules: RULES,
									replies: {
										...fixture.input.replies,
										decisions: needsOwner
											? [
													decidedReply({
														action: 'needs-owner',
														reason: 'An owner must decide.',
													}),
												]
											: [],
									},
								})
							).pipe(Effect.provide(fixture.publisher), Effect.flip)
						).toBe(error)
						const replies = fixture.fake.writes.filter(
							write => write.method === 'reply'
						)
						expect(replies).toHaveLength(needsOwner ? 1 : 0)
						if (needsOwner) {
							expect(parseReplyMarker(replies[0]?.body ?? '')).toMatchObject({
								action: 'needs-owner',
							})
							expect(fixture.status.statuses).toMatchObject([
								{ sha: fixture.head, state: 'failure' },
							])
							expect(fixture.fake.writes.map(write => write.method)).toEqual([
								'reply',
								'unresolve',
								'editReply',
								'updateReview',
								'label',
							])
						} else expect(fixture.status.statuses).toEqual([])
						expect(
							fixture.fake.writes.filter(
								write => write.method === 'label' || write.method === 'unlabel'
							)
						).toEqual(
							needsOwner
								? [{ method: 'label', pullNumber: 17, name: 'needs-owner' }]
								: []
						)
						expect(fixture.status.checks).toEqual([])
					})
			)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'ReplyPublishService resolved held confirmations',
	test => {
		for (const severity of ['high', 'critical'] as const)
			test.effect(
				`a held reply confirming a ${severity} bug is counted as open after its answer`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const original = threadAtCommit(fixture.base)
						const root = original.comments.nodes.map(comment => ({
							...comment,
							body: comment.body.replace(
								'"severity":"high"',
								`"severity":"${severity}"`
							),
						}))
						const reply = threadReply({
							databaseId: 42,
							body: 'confirmed',
							createdAt: '2026-01-01T12:00:00Z',
							author: { __typename: 'User', login: 'contributor' },
						})
						const answer = threadReply({
							databaseId: 50,
							createdAt: '2026-01-02T12:00:00Z',
							body: toMarkerComment('reply', {
								v: 1,
								action: 'resolved',
								commit: fixture.head,
								reply: 41,
							}),
						})
						fixture.fake.threads.push({
							...original,
							isResolved: true,
							comments: { ...original.comments, nodes: root, totalCount: 3 },
							latest: { nodes: [reply, answer] },
						})
						fixture.fake.threadComments.set('thread', [...root, reply, answer])
						expect(
							yield* ReplyPublishService.use(service =>
								service.publish({
									...fixture.input,
									run: 7,
									held: 42,
									replies: {
										...fixture.input.replies,
										decisions: [
											decidedReply(
												{
													action: 'still-found',
													reason: 'The writer confirms the bug.',
												},
												{ digest: toBodyDigest('confirmed') }
											),
										],
									},
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({
							answered: { 'still-found': 1 },
							openBugs: 1,
							verdict: 'needs fixes',
						})
					})
			)
		for (const confirmed of [true, false])
			test.effect(
				`a held reply keeps a resolved bug open, reporting it to the raise only when confirmed=${confirmed}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const original = threadAtCommit(fixture.base)
						const root = original.comments.nodes.map(comment => ({
							...comment,
							body: comment.body
								.replace(',"confirmed":true', '')
								.replace(
									'"severity":"high"',
									confirmed
										? '"severity":"high","confirmed":true'
										: '"severity":"high"'
								),
						}))
						const reply = threadReply({
							databaseId: 42,
							body: 'confirmed',
							createdAt: '2026-01-01T12:00:00Z',
							author: { __typename: 'User', login: 'contributor' },
						})
						const answer = threadReply({
							databaseId: 50,
							createdAt: '2026-01-02T12:00:00Z',
							body: toMarkerComment('reply', {
								v: 1,
								action: 'resolved',
								commit: fixture.head,
								reply: 41,
							}),
						})
						fixture.fake.threads.push({
							...original,
							isResolved: true,
							comments: { ...original.comments, nodes: root, totalCount: 3 },
							latest: { nodes: [reply, answer] },
						})
						fixture.fake.threadComments.set('thread', [...root, reply, answer])
						const result = yield* ReplyPublishService.use(service =>
							service.publish({
								...fixture.input,
								run: 7,
								held: 42,
								replies: {
									...fixture.input.replies,
									decisions: [
										decidedReply(
											{
												action: 'still-found',
												reason: 'The writer confirms the bug.',
											},
											{ digest: toBodyDigest('confirmed') }
										),
									],
								},
							})
						).pipe(Effect.provide(fixture.publisher))
						expect(result).toMatchObject({
							answered: { 'still-found': 1 },
							openBugs: 1,
						})
						expect(result.reopened).toEqual(confirmed ? ['high'] : undefined)
						const { identities } = yield* OwnedIdentities
						const next = yield* GitHubApiService.use(api =>
							api.listReviewThreads(17)
						).pipe(Effect.provide(fixture.fake.api))
						expect(
							next
								.flatMap(thread => toBotThread(thread, identities) ?? [])
								.filter(
									thread => !thread.resolved && thread.marker.kind === 'bug'
								)
						).toHaveLength(1)
					})
			)
	}
)

/** A resolved thread with a held writer reply the run sends to the owner. */
function heldOwnerThread(fixture: ReturnType<typeof setup>) {
	const original = threadAtCommit(fixture.base)
	const reply = threadReply({
		databaseId: 42,
		body: 'disputed',
		createdAt: '2026-01-01T12:00:00Z',
		author: { __typename: 'User', login: 'contributor' },
	})
	fixture.fake.threads.push({
		...original,
		isResolved: true,
		resolvedBy: { login: 'contributor' },
		comments: { ...original.comments, totalCount: 2 },
		latest: { nodes: [reply] },
	})
	fixture.fake.threadComments.set('thread', [...original.comments.nodes, reply])
	return {
		...fixture.input,
		rules: RULES,
		run: 7,
		held: 42,
		replies: {
			...fixture.input.replies,
			decisions: [
				decidedReply(
					{ action: 'needs-owner', reason: 'An owner must decide.' },
					{ digest: toBodyDigest('disputed') }
				),
			],
		},
	} satisfies ReplyPublishInput
}

/** Marks the fixture's thread resolved by the admin `contributor`. */
function resolveByOwner(fixture: ReturnType<typeof setup>) {
	const index = fixture.fake.threads.findIndex(thread => thread.id === 'thread')
	const thread = fixture.fake.threads[index]
	if (thread)
		fixture.fake.threads[index] = {
			...thread,
			isResolved: true,
			resolvedBy: { login: 'contributor' },
		}
}

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'ReplyPublishService owner waits',
	test => {
		test.effect(
			'a failed second thread read keeps a wait the first read showed resolved',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.splice(
						0,
						1,
						summaryReview(
							{
								...SUMMARY_MARKER,
								head: fixture.head,
								finished: true,
								needsOwner: ['thread'],
							},
							{
								author: {
									__typename: 'Bot',
									login: GITHUB_ACTIONS_IDENTITY.login,
								},
							}
						)
					)
					fixture.fake.threads.push({
						...threadAtCommit(fixture.base),
						isResolved: true,
						resolvedBy: { login: 'contributor' },
					})
					fixture.fake.failures.listThreads.push(
						undefined,
						new GitHubApiError({ operation: 'threads', reason: 'unavailable' })
					)
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ waiting: 1 })
				})
		)
		test.effect(
			'a longer owner thread that cannot be read whole keeps waiting',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.threads.push(
						ownerReviewThread(RECENT_COMMENTS + 1, { id: 'long' })
					)
					fixture.fake.failures.listThreadComments.push(
						new GitHubApiError({
							operation: 'listThreadComments',
							reason: 'unavailable',
						})
					)
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ waiting: 1 })
				})
		)
		test.effect(
			'holds the longer threads of a failed whole-thread read for that run only, then keeps only a real wait',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const { unanswered, answered, answeredComments } = longOwnerThreads()
					fixture.fake.threads.push(unanswered, answered)
					fixture.fake.threadComments.set(answered.id, [...answeredComments])
					fixture.fake.failures.listThreadComments.push(
						new GitHubApiError({
							operation: 'listThreadComments',
							reason: 'unavailable',
						})
					)
					const run = ReplyPublishService.use(service =>
						service.publish(fixture.input)
					).pipe(Effect.provide(fixture.publisher))
					expect(yield* run).toMatchObject({
						verdict: 'needs owner',
						waiting: 2,
						label: 'none',
					})
					expect(fixture.status.statuses.at(-1)?.state).toBe('failure')
					expect(
						parseSummaryMarker(fixture.fake.reviews.at(-1)?.body ?? '')
							?.needsOwner
					).toBeUndefined()
					expect(yield* run).toMatchObject({
						verdict: 'needs owner',
						waiting: 1,
						label: 'added',
					})
					expect(
						parseSummaryMarker(fixture.fake.reviews.at(-1)?.body ?? '')
							?.needsOwner
					).toEqual([answered.id])
				})
		)
		for (const reopened of [true, false])
			test.effect(
				`an owner resolving between the reopen and the answer keeps the wait, reopened after=${reopened}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const input = heldOwnerThread(fixture)
						fixture.fake.beforeReply.push(() => resolveByOwner(fixture))
						if (!reopened)
							fixture.fake.failures.unresolve.push(
								undefined,
								new GitHubApiError({
									operation: 'unresolve',
									reason: 'unavailable',
								})
							)
						expect(
							yield* ReplyPublishService.use(service =>
								service.publish(input)
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({ answered: { 'needs-owner': 1 }, waiting: 1 })
						expect(
							fixture.fake.writes
								.map(write => write.method)
								.filter(method => method !== 'updateReview')
								.slice(0, 3)
						).toEqual(['unresolve', 'reply', 'unresolve'])
					})
			)
		test.effect(
			'a failed reopen after the answer keeps the wait and the bug through a sweep and later publishes',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const input = heldOwnerThread(fixture)
					fixture.fake.beforeReply.push(() => resolveByOwner(fixture))
					fixture.fake.failures.unresolve.push(
						undefined,
						new GitHubApiError({
							operation: 'unresolve',
							reason: 'unavailable',
						})
					)
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish(input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ waiting: 1, unsettled: 1 })
					const { identities } = yield* OwnedIdentities
					const [thread] = fixture.fake.threads
					expect(thread && toBotThread(thread, identities)).toMatchObject({
						resolved: true,
						unsettled: true,
					})
					const sweepStatus = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, fixture.head)]),
						getStatus: () =>
							Effect.succeed({
								id: 1,
								state: 'success',
								description: 'stale',
								context: 'MNG Review',
								creator: null,
							}),
					})
					yield* StatusSweepService.use(service => service.sweep([])).pipe(
						Effect.provide(
							StatusSweepServiceLive.pipe(
								Layer.provide(Layer.merge(sweepStatus.layer, fixture.fake.api))
							)
						)
					)
					expect(sweepStatus.statuses).toEqual([
						{ sha: fixture.head, ...toCommitStatus('needs owner', 1, true) },
					])
					// A later run cannot reopen it either: the wait stays.
					fixture.fake.failures.unresolve.push(
						new GitHubApiError({
							operation: 'unresolve',
							reason: 'unavailable',
						})
					)
					const later = { ...fixture.input, rules: RULES }
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish(later)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ waiting: 1, unsettled: 1 })
					// The next run reopens and settles it: open now, so it still waits.
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish(later)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ waiting: 1, unsettled: 0 })
					// Only a resolution after that clears the wait.
					resolveByOwner(fixture)
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish(later)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ waiting: 0, unsettled: 0 })
					expect(
						fixture.fake.writes.map(write => write.method).includes('unlabel')
					).toBeTruthy()
				})
		)
		test.effect('a resolution after the answer clears the wait', () =>
			Effect.gen(function* () {
				const fixture = setup()
				const input = heldOwnerThread(fixture)
				fixture.fake.threadSnapshots.push([...fixture.fake.threads])
				fixture.fake.beforeReply.push(() => {
					resolveByOwner(fixture)
					fixture.fake.threadSnapshots.push([...fixture.fake.threads])
				})
				expect(
					yield* ReplyPublishService.use(service =>
						service.publish(input)
					).pipe(Effect.provide(fixture.publisher))
				).toMatchObject({ answered: { 'needs-owner': 1 }, waiting: 0 })
			})
		)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'ReplyPublishService unsettled bug threads',
	test => {
		for (const place of ['window', 'outside'] as const)
			test.effect(
				`counts a resolved bug whose unsettled answer is ${place} its window as open`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const { thread, comments } = unsettledBugThread(place)
						fixture.fake.threads.push(thread)
						fixture.fake.threadComments.set(thread.id, [...comments])
						fixture.fake.failures.unresolve.push(
							new GitHubApiError({ operation: 'unresolve', reason: 'down' })
						)
						expect(
							yield* ReplyPublishService.use(service =>
								service.publish(fixture.input)
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({ openBugs: 1, unsettled: 1 })
					})
			)
	}
)

/** Who may clear a wait in the raise below: `contributor`, listed in `commands.allow`. */
const OWNER_ALLOW = ['contributor'] as const

/** Marks the fixture's thread resolved by `login`. */
function resolveThreadBy(fixture: ReturnType<typeof setup>, login: string) {
	const index = fixture.fake.threads.findIndex(thread => thread.id === 'thread')
	const thread = fixture.fake.threads[index]
	if (thread)
		fixture.fake.threads[index] = {
			...thread,
			isResolved: true,
			resolvedBy: { login },
		}
}

/**
 * The reply schedule's find and locked job on the fixture's pull request, over the statuses the
 * reply run wrote: the head's status is the newest one written.
 */
function raiseAfterRun(fixture: ReturnType<typeof setup>) {
	const raiseStatus = githubStatusFake({
		listOpenPullRequests: () =>
			Effect.succeed([openPullRequest(17, fixture.head)]),
		getStatus: () => {
			const newest = fixture.status.statuses.at(-1)
			return Effect.succeed(
				newest && {
					id: fixture.status.statuses.length,
					state: newest.state,
					description: newest.description,
					context: 'MNG Review',
					creator: null,
				}
			)
		},
		setStatus: input =>
			Effect.sync(() => {
				fixture.status.statuses.push(input)
			}),
	})
	const raising = RaiseServiceLive.pipe(
		Layer.provide(Layer.merge(raiseStatus.layer, fixture.fake.api))
	)
	return {
		findDue: RaiseService.use(service => service.findDue(OWNER_ALLOW)).pipe(
			Effect.provide(raising)
		),
		raise: RaiseService.use(service => service.raise(17, OWNER_ALLOW)).pipe(
			Effect.provide(raising)
		),
	}
}

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'ReplyPublishService then the raise',
	test => {
		test.effect(
			'a wait a failed summary write left off the marker holds the raise until an owner resolves its thread',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const { head } = fixture
					fixture.fake.reviews.splice(
						0,
						1,
						summaryReview(
							{ ...SUMMARY_MARKER, head, finished: true },
							{ state: 'CHANGES_REQUESTED', commit: { oid: head } }
						)
					)
					fixture.fake.command.role = 'write'
					const { pullRequest } = fixture.fake.command
					fixture.fake.command.pullRequest = {
						...pullRequest,
						head: { ...pullRequest.head, sha: head },
					}
					fixture.fake.threads.push(threadAtCommit(fixture.base))
					fixture.fake.failures.updateReview.push(
						new GitHubApiError({
							operation: 'updateReview',
							reason: 'summary unavailable',
							status: 503,
						})
					)
					yield* ReplyPublishService.use(service =>
						service.publish({
							...fixture.input,
							rules: RULES,
							replies: {
								...fixture.input.replies,
								decisions: [
									decidedReply({
										action: 'needs-owner',
										reason: 'An owner must decide.',
									}),
								],
							},
						})
					).pipe(Effect.provide(fixture.publisher), Effect.flip)
					// The run set `needs owner` and the label, but its wait never reached the marker.
					expect(fixture.status.statuses).toEqual([
						{ sha: head, ...toCommitStatus('needs owner', 1, true) },
					])
					expect(
						parseSummaryMarker(fixture.fake.reviews[0]?.body ?? '')?.needsOwner
					).toBeUndefined()
					// A writer who may not clear the wait resolves the bug thread: only the wait blocks now.
					resolveThreadBy(fixture, 'writer')
					const next = raiseAfterRun(fixture)
					yield* next.findDue
					expect(yield* next.raise).toMatchObject({
						status: toCommitStatus('needs owner', 0, true),
						dismissal: { dismissed: 0, failed: 0 },
					})
					expect(
						fixture.status.statuses.filter(status => status.state === 'success')
					).toEqual([])
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'dismissReview'
						)
					).toEqual([])
					// The owner resolves the thread by hand: one schedule run clears it.
					resolveThreadBy(fixture, 'contributor')
					expect((yield* next.findDue).pulls).toEqual([17])
					expect(yield* next.raise).toMatchObject({
						outcome: 'raised',
						status: toCommitStatus('ready', 0, true),
						dismissal: { dismissed: 1, failed: 0 },
					})
					expect(
						fixture.fake.reviews.filter(
							review => review.state === 'CHANGES_REQUESTED'
						)
					).toEqual([])
				})
		)
	}
)

/** When the last full run finished on the head, and when a later run's error was written. */
const REVIEWED_AT = '2026-11-20T10:00:00.000Z'
const ERROR_AT = '2026-11-20T10:01:00.000Z'
/** Who may clear a wait or lift a change request in the raises below. */
const NO_ALLOW = [] as const

/** The head's `error` a later run wrote, as the status read returns it. */
function laterError(description: string) {
	return {
		id: 1,
		state: 'error',
		description,
		context: 'MNG Review',
		creator: null,
		created_at: ERROR_AT,
	} as const
}

/**
 * The fixture after a full run that finished on the head at `REVIEWED_AT`, with its change request,
 * the head as the pull request's; `statusOverrides` is the status boundary of the runs that follow.
 */
function finishedSetup(statusOverrides: StatusOverrides = {}) {
	const fixture = setup(statusOverrides)
	const { head } = fixture
	fixture.fake.reviews.splice(
		0,
		1,
		summaryReview(
			{ ...SUMMARY_MARKER, head, finished: true, reviewedAt: REVIEWED_AT },
			{
				state: 'CHANGES_REQUESTED',
				commit: { oid: head },
				createdAt: REVIEWED_AT,
				submittedAt: REVIEWED_AT,
			}
		)
	)
	fixture.fake.command.role = 'write'
	const { pullRequest } = fixture.fake.command
	fixture.fake.command.pullRequest = {
		...pullRequest,
		head: { ...pullRequest.head, sha: head },
	}
	return fixture
}

/** The raise over the fixture's pull request while the head's status stays `error`. */
function raiseOverError(
	fixture: ReturnType<typeof setup>,
	error: ReturnType<typeof laterError>
) {
	const raiseStatus = githubStatusFake({
		listOpenPullRequests: () =>
			Effect.succeed([openPullRequest(17, fixture.head)]),
		getStatus: () => Effect.succeed(error),
	})
	const raising = RaiseServiceLive.pipe(
		Layer.provide(Layer.merge(raiseStatus.layer, fixture.fake.api))
	)
	return {
		statuses: raiseStatus.statuses,
		findDue: RaiseService.use(service => service.findDue(NO_ALLOW)).pipe(
			Effect.provide(raising)
		),
		raise: RaiseService.use(service => service.raise(17, NO_ALLOW)).pipe(
			Effect.provide(raising)
		),
	}
}

/** The newest summary marker on the fake. */
function newestMarker(fixture: ReturnType<typeof setup>) {
	return parseSummaryMarker(fixture.fake.reviews.at(-1)?.body ?? '')
}

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'ReplyPublishService and the raise after a later error',
	test => {
		test.effect(
			'a command that reserves after a failed publish and then publishes nothing leaves the raise held',
			() =>
				Effect.gen(function* () {
					const fixture = finishedSetup()
					const error = laterError(`publishing failed; ${UNFINISHED_NOTE}`)
					// The reservation edits the summary, then the review ends failed, skipped or with an
					// invalid config: nothing is published and no status is written.
					expect(
						yield* SummaryReviewService.use(service =>
							service.reserveManualRun({
								pullNumber: 17,
								head: fixture.head,
								engineCommit: 'engine',
								maxRuns: 5,
								handle: 'mng-review',
							})
						).pipe(Effect.provide(fixture.summaries))
					).toBeTruthy()
					expect(newestMarker(fixture)).toMatchObject({
						finished: true,
						manualRuns: 1,
						reviewedAt: REVIEWED_AT,
					})
					const next = raiseOverError(fixture, error)
					expect((yield* next.findDue).pulls).toEqual([])
					expect((yield* next.raise).outcome).toBe('not-due')
					expect(next.statuses).toEqual([])
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'dismissReview'
						)
					).toEqual([])
				})
		)
		test.effect(
			'a reply-only run whose own status write does not land leaves the raise held',
			() =>
				Effect.gen(function* () {
					const fixture = finishedSetup({
						setStatus: () =>
							Effect.fail(
								new GitHubApiError({
									operation: 'setStatus',
									reason: 'unavailable',
									status: 503,
								})
							),
					})
					const error = laterError(`publishing failed; ${UNFINISHED_NOTE}`)
					yield* ReplyPublishService.use(service =>
						service.publish({ ...fixture.input, rules: RULES })
					).pipe(Effect.provide(fixture.publisher))
					// The run edited the summary and carried the earlier run's stamp; its status never landed.
					expect(newestMarker(fixture)).toMatchObject({
						finished: true,
						reviewedAt: REVIEWED_AT,
					})
					// The run's own writes are its publish job's; the raise adds none.
					const writes = fixture.fake.writes.length
					const next = raiseOverError(fixture, error)
					expect((yield* next.findDue).pulls).toEqual([])
					expect((yield* next.raise).outcome).toBe('not-due')
					expect(next.statuses).toEqual([])
					expect(fixture.fake.writes).toHaveLength(writes)
				})
		)
		test.effect(
			'an offline run marks the summary unfinished before its error, so the raise writes no success',
			() =>
				Effect.gen(function* () {
					const fixture = finishedSetup()
					yield* SummaryReviewService.use(service =>
						service.publishStatus({
							pullNumber: 17,
							head: fixture.head,
							engineCommit: 'engine',
							status: 'Reviewer offline',
						})
					).pipe(Effect.provide(fixture.summaries))
					expect(newestMarker(fixture)).toMatchObject({
						finished: false,
						reviewedAt: REVIEWED_AT,
					})
					const next = raiseOverError(
						fixture,
						laterError(`the reviewer was offline; ${UNFINISHED_NOTE}`)
					)
					yield* next.findDue
					yield* next.raise
					expect(
						next.statuses.filter(status => status.state === 'success')
					).toEqual([])
				})
		)
	}
)
