import { layer } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { githubStatusFake } from '../../../shared/mocks/github-status-fake.helper'
import {
	ACCEPTING_RULES,
	summaryReview,
	SUMMARY_MARKER,
	RULES,
	TOKEN_MODE_OWNED,
} from '../../../shared/mocks/publish-test.helper'
import {
	ACCEPTED_DECISION,
	decidedReply,
	pendingReviewThread,
} from '../../../shared/mocks/thread-reply-test.helper'
import { parseReplyMarker } from '../domain/publish-marker.parser'
import type { ThreadReplyDecision } from '../domain/thread-reply.schema'
import {
	ReplyPublishService,
	ReplyPublishServiceLive,
	type ReplyPublishInput,
} from './reply-publish.service'
import { SummaryReviewServiceLive } from './summary-review.service'

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

/** Real local history and recording GitHub boundaries, with no model or HTTP layer. */
function setup() {
	const repo = createRepo()
	const original = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
	repo.write('src/store.ts', original)
	const base = repo.commit()
	repo.write('src/store.ts', original.replace('line 10\n', 'changed 10\n'))
	const head = repo.commit()
	const fake = githubApiFake()
	const status = githubStatusFake()
	fake.reviews.push(
		summaryReview(
			{ ...SUMMARY_MARKER, head, finished: true },
			{ author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login } }
		)
	)
	const publisher = ReplyPublishServiceLive.pipe(
		Layer.provide(SummaryReviewServiceLive),
		Layer.provide(
			Layer.mergeAll(
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
		)
	)
	const input = {
		pullNumber: 17,
		head,
		engineCommit: 'engine',
		rules: ACCEPTING_RULES,
		replies: { base, tokens: {}, decisions: [] },
	} as const satisfies ReplyPublishInput
	return { repo, base, head, fake, status, publisher, input }
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
