import { layer } from '@effect/vitest'
import { Effect } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { REVIEW_STATE_BY_EVENT } from '../../../platform/github-review.service'
import { cleanupRepos } from '../../../shared/mocks/git-test.helper'
import { publishEventFixture } from '../../../shared/mocks/publish-event-test.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	TOKEN_MODE_OWNED,
	bug,
	agentReport,
	reviewThread,
	summaryReview,
	SUMMARY_MARKER,
	ACCEPTING_RULES,
} from '../../../shared/mocks/publish-test.helper'
import {
	decidedReply,
	pendingReviewThread,
	ownerReviewThread,
	ACCEPTED_DECISION,
} from '../../../shared/mocks/thread-reply-test.helper'
import { PublishService } from './publish.service'
import { ReplyPublishService } from './reply-publish.service'

afterEach(cleanupRepos)

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService events',
	test => {
		for (const command of [undefined, { agentOnly: false }] as const)
			test.effect(
				`a clean full ${command ? 'command' : 'push'} approves under the default app preset`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						expect(
							yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									...(command ? { command } : {}),
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({
							verdict: 'ready',
							event: 'APPROVE',
							finished: true,
						})
						expect(fixture.fake.writes[0]).toMatchObject({
							method: 'review',
							input: { event: 'APPROVE', comments: [] },
						})
					})
			)
		test.effect('preview mode comments on a clean full run', () =>
			Effect.gen(function* () {
				const fixture = publishEventFixture()
				expect(
					yield* PublishService.use(service =>
						service.publish({
							...fixture.input,
							rules: {
								...fixture.input.rules,
								config: {
									...fixture.input.rules.config,
									verdict: {
										...fixture.input.rules.config.verdict,
										mode: 'preview',
									},
								},
							},
						})
					).pipe(Effect.provide(fixture.publisher))
				).toMatchObject({ verdict: 'ready', event: 'COMMENT' })
				expect(fixture.fake.writes[0]).toMatchObject({
					method: 'review',
					input: { event: 'COMMENT' },
				})
			})
		)
		for (const condition of [
			'single-agent',
			'moved-head',
			'unfinished',
			'unverified',
			'nit',
			'below-floor',
		] as const)
			test.effect(`${condition} does not approve`, () =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					if (condition === 'moved-head')
						fixture.fake.command.pullRequest = {
							...fixture.fake.command.pullRequest,
							head: {
								...fixture.fake.command.pullRequest.head,
								sha: 'different-head',
							},
						}
					const finding = bug({
						kind: condition === 'nit' ? 'nit' : 'bug',
						placement:
							condition === 'unverified' || condition === 'below-floor'
								? 'summary'
								: 'inline',
						severity: condition === 'unverified' ? 'high' : 'low',
						...(condition === 'unverified'
							? {
									validation: {
										status: 'unverified',
										severity: 'high',
										premise: 'Retry',
										reason: 'Unproven',
										evidence: [],
										model: 'model-a',
									},
								}
							: {}),
					})
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								...(['single-agent', 'moved-head'].includes(condition)
									? { command: { agentOnly: condition === 'single-agent' } }
									: {}),
								report: {
									...fixture.input.report,
									bugs:
										condition === 'unverified' || condition === 'below-floor'
											? [finding]
											: [],
									nits: condition === 'nit' ? [finding] : [],
									...(condition === 'unfinished'
										? { agents: [agentReport('failed')] }
										: {}),
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ event: 'COMMENT' })
					expect(
						fixture.fake.writes.filter(write => write.method === 'review')
					).toMatchObject([{ input: { event: 'COMMENT' } }])
				})
			)
		test.effect(
			'a confirmed bug requests changes and a later clean preview run dismisses that request',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(
						yield* publisher.publish({
							...fixture.input,
							report: { ...fixture.input.report, bugs: [bug()] },
						})
					).toMatchObject({ verdict: 'needs fixes', event: 'REQUEST_CHANGES' })
					expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
					const [thread] = fixture.fake.threads
					expect(thread).toBeDefined()
					if (!thread) return
					fixture.repo.write('src/store.ts', 'guarded write\n')
					const head = fixture.repo.commit()
					fixture.fake.command.pullRequest = {
						...fixture.fake.command.pullRequest,
						head: { ...fixture.fake.command.pullRequest.head, sha: head },
					}
					expect(
						yield* publisher.publish({
							...fixture.input,
							head,
							rules: {
								...fixture.input.rules,
								config: {
									...fixture.input.rules.config,
									verdict: {
										...fixture.input.rules.config.verdict,
										mode: 'preview',
									},
								},
							},
							recheck: {
								checked: 1,
								proposals: [
									{
										threadId: thread.id,
										fingerprint: bug().fingerprint,
										reason: 'The guard fixes it.',
									},
								],
								tokens: {},
							},
						})
					).toMatchObject({ verdict: 'ready', event: 'COMMENT', resolved: 1 })
					expect(fixture.fake.reviews[0]?.state).toBe('DISMISSED')
					expect(
						fixture.fake.writes
							.filter(write => write.method === 'review')
							.map(write => write.input.event)
					).toEqual(['REQUEST_CHANGES', 'COMMENT'])
					expect(
						fixture.fake.writes.filter(
							write => write.method === 'dismissReview'
						)
					).toHaveLength(1)
				})
		)
		for (const partial of [false, true])
			test.effect(
				`a confirmed bug requests changes even with single-agent=${partial}`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						expect(
							yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									command: { agentOnly: partial },
									report: { ...fixture.input.report, bugs: [bug()] },
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({ event: 'REQUEST_CHANGES' })
					})
			)
	}
)

layer(TOKEN_MODE_OWNED, { excludeTestServices: true })(
	'PublishService token events',
	test => {
		test.effect(
			'a clean full token run comments without attempting approval',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture(GITHUB_ACTIONS_IDENTITY)
					expect(
						yield* PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ verdict: 'ready', event: 'COMMENT' })
					expect(
						fixture.fake.writes
							.filter(write => write.method === 'review')
							.map(write => write.input.event)
					).toEqual(['COMMENT'])
				})
		)
	}
)

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'ReplyPublishService events',
	test => {
		for (const mode of ['approve', 'preview'] as const)
			test.effect(
				`closing the last bug in a reply-only run comments and clears with ${mode}`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						fixture.fake.reviews.push(
							summaryReview(
								{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
								{
									state: 'CHANGES_REQUESTED',
									author: { __typename: 'Bot', login: APP_IDENTITY.login },
								}
							)
						)
						fixture.fake.threads.push(pendingReviewThread())
						const event = 'COMMENT'
						expect(
							yield* ReplyPublishService.use(service =>
								service.publish({
									pullNumber: 17,
									head: fixture.head,
									engineCommit: 'engine',
									rules: {
										...ACCEPTING_RULES,
										config: {
											...ACCEPTING_RULES.config,
											verdict: { ...ACCEPTING_RULES.config.verdict, mode },
										},
									},
									replies: {
										base: fixture.base,
										tokens: {},
										decisions: [
											decidedReply({
												...ACCEPTED_DECISION,
												evidence: ['src/store.ts:12'],
											}),
										],
									},
								})
							).pipe(Effect.provide(fixture.replyPublisher))
						).toMatchObject({
							verdict: 'ready',
							event,
							openBugs: 0,
							answered: { accepted: 1 },
						})
						expect(fixture.fake.threads[0]?.isResolved).toBe(true)
						expect(
							fixture.fake.writes.filter(write => write.method === 'review')
						).toMatchObject([{ input: { event } }])
						expect(
							fixture.fake.writes.filter(
								write => write.method === 'dismissReview'
							)
						).toHaveLength(1)
					})
			)
		for (const concern of [
			'nit',
			'unverified',
			'bug',
			'owner',
			'none',
		] as const)
			test.effect(`a reply-only run with open ${concern} never approves`, () =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						summaryReview(
							{
								...SUMMARY_MARKER,
								head: fixture.head,
								finished: true,
								...(concern === 'owner' ? { needsOwner: ['thread'] } : {}),
							},
							{ author: { __typename: 'Bot', login: APP_IDENTITY.login } }
						)
					)
					if (concern !== 'none')
						fixture.fake.threads.push(
							concern === 'owner'
								? ownerReviewThread()
								: reviewThread({ finding: bug(), kind: concern })
						)
					// Ready comments and clears; a bug or a waiting thread on the head requests changes.
					const event =
						concern === 'bug' || concern === 'owner'
							? 'REQUEST_CHANGES'
							: 'COMMENT'
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish({
								pullNumber: 17,
								head: fixture.head,
								engineCommit: 'engine',
								rules: fixture.input.rules,
								replies: { base: fixture.base, tokens: {}, decisions: [] },
							})
						).pipe(Effect.provide(fixture.replyPublisher))
					).toMatchObject({ event })
					const states = fixture.fake.reviews.at(-1)?.state
					expect(states).toBe(REVIEW_STATE_BY_EVENT[event])
				})
			)
	}
)
