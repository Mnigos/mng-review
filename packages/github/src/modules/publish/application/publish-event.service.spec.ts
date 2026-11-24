import { layer } from '@effect/vitest'
import { Effect } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { REVIEW_STATE_BY_EVENT } from '../../../platform/github-review.service'
import { GitHubApiError } from '../../../platform/github.errors'
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
import { parseSummaryMarker } from '../domain/publish-marker.parser'
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
					const reviews = fixture.fake.writes.filter(
						write => write.method === 'review'
					)
					expect(reviews).toMatchObject([{ input: { event: 'COMMENT' } }])
					const reason = {
						'single-agent':
							'this run reviewed with one agent only, so the earlier state stands.',
						'moved-head':
							'the pull request moved to another commit, or could not be read again',
						unfinished: 'review run(s) failed or did not report.',
						unverified: 'only findings that do not block remain (1: unverified',
						nit: 'only findings that do not block remain (1: unverified',
						'below-floor':
							'only findings that do not block remain (1: unverified',
					}[condition]
					const [review] = reviews
					const body = review?.method === 'review' ? review.input.body : ''
					expect(body.startsWith('**Comment.** Not approved: ')).toBeTruthy()
					expect(body.split('\n')[0]).toContain(reason)
				})
			)
		test.effect(
			'a finished push whose main reviewer left files unread comments and says how many',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								report: {
									...fixture.input.report,
									agents: fixture.input.report.agents.map(agent => ({
										...agent,
										unread: 2,
									})),
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ verdict: 'ready', event: 'COMMENT' })
					const [review] = fixture.fake.writes
					expect(review).toMatchObject({
						method: 'review',
						input: { event: 'COMMENT' },
					})
					expect(
						(review?.method === 'review' ? review.input.body : '').split(
							'\n'
						)[0]
					).toBe(
						'**Comment.** Not approved: the main reviewer answered without reading 2 changed file(s).'
					)
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

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService verdict evidence',
	test => {
		for (const condition of [
			'quick',
			'no-report',
			'unit-error',
			'agent-endpoint',
			'binary',
			'too_large',
			'skip.paths',
			'unverified',
			'nit',
			'below-floor',
		] as const)
			test.effect(
				`${condition} coverage controls approval and whether a finished ready run clears`,
				() =>
					Effect.gen(function* () {
						// A failed or missing run keeps the change request; other gaps only block approval.
						const failed =
							condition === 'no-report' ||
							condition === 'unit-error' ||
							condition === 'agent-endpoint'
						const fixture = publishEventFixture()
						fixture.fake.reviews.push(
							summaryReview(
								{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
								{
									state: 'CHANGES_REQUESTED',
									commit: { oid: fixture.head },
									author: { __typename: 'Bot', login: APP_IDENTITY.login },
								}
							)
						)
						const finding = bug({
							placement: 'summary',
							severity: 'low',
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
						const reviewed = fixture.input.report
						const published = yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								report: {
									...reviewed,
									bugs:
										condition === 'unverified' || condition === 'below-floor'
											? [finding]
											: [],
									nits:
										condition === 'nit' ? [{ ...finding, kind: 'nit' }] : [],
									agents:
										condition === 'no-report'
											? []
											: reviewed.agents.map(agent => ({
													...agent,
													...(condition === 'unit-error'
														? {
																error: '1 of 2 units did not finish: LoopError',
															}
														: {}),
													...(condition === 'agent-endpoint'
														? { endpointError: true }
														: {}),
												})),
									planReport: {
										...reviewed.planReport,
										plan: {
											...reviewed.planReport.plan,
											...(condition === 'quick'
												? {
														depth: 'quick',
														runs: reviewed.planReport.plan.runs.filter(
															run => run.role !== 'reviewer'
														),
													}
												: {}),
										},
										change: {
											...reviewed.planReport.change,
											files: reviewed.planReport.change.files.map(file => ({
												...file,
												...(condition === 'binary' ||
												condition === 'too_large' ||
												condition === 'skip.paths'
													? { skipped: condition }
													: {}),
											})),
										},
									},
								},
							})
						).pipe(Effect.provide(fixture.publisher))
						expect(published).toMatchObject({
							verdict: 'ready',
							event:
								condition === 'skip.paths'
									? 'APPROVE'
									: failed
										? 'REQUEST_CHANGES'
										: 'COMMENT',
							finished: true,
							dismissal: {
								dismissed: condition === 'skip.paths' || failed ? 0 : 1,
								failed: 0,
							},
						})
						expect(fixture.fake.reviews[0]?.state).toBe(
							condition === 'skip.paths' || failed
								? 'CHANGES_REQUESTED'
								: 'DISMISSED'
						)
					})
			)
		for (const kind of ['unverified', 'nit', 'bug'] as const)
			for (const resolved of [false, true])
				test.effect(
					`publishing rereads an owned ${resolved ? 'resolved' : 'open'} ${kind} thread before deciding coverage`,
					() =>
						Effect.gen(function* () {
							const fixture = publishEventFixture()
							fixture.fake.threadSnapshots.push(
								[],
								[
									reviewThread(
										{ finding: bug(), kind },
										{ isResolved: resolved }
									),
								]
							)
							expect(
								yield* PublishService.use(service =>
									service.publish(fixture.input)
								).pipe(Effect.provide(fixture.publisher))
							).toMatchObject({
								event: resolved
									? 'APPROVE'
									: kind === 'bug'
										? 'REQUEST_CHANGES'
										: 'COMMENT',
							})
							expect(fixture.fake.threadReads).toEqual([17, 17])
						})
				)
		for (const condition of [
			'incomplete-agent',
			'failed-agent',
			'report-endpoint',
			'incomplete-report',
			'single-agent',
			'moved-head',
			'unreadable-head',
		] as const)
			for (const editable of [false, true])
				test.effect(
					`${condition} keeps a standing change request, editable=${editable}`,
					() =>
						Effect.gen(function* () {
							// A run off the current head never edits a change request on it; posts comment.
							const edits = editable && condition !== 'moved-head'
							const fixture = publishEventFixture()
							const marker = {
								...SUMMARY_MARKER,
								runs: 4,
								head: fixture.head,
								finished: true,
							} as const
							fixture.fake.reviews.push(
								summaryReview(marker, {
									state: 'CHANGES_REQUESTED',
									commit: { oid: fixture.head },
									isMinimized: !editable,
									author: { __typename: 'Bot', login: APP_IDENTITY.login },
								})
							)
							if (condition === 'moved-head')
								fixture.fake.command.pullRequest = {
									...fixture.fake.command.pullRequest,
									head: {
										...fixture.fake.command.pullRequest.head,
										sha: 'next-head',
									},
								}
							if (condition === 'unreadable-head')
								fixture.fake.failures.getPullRequest.push(
									new GitHubApiError({
										operation: 'getPullRequest',
										reason: 'Denied',
										status: 403,
									})
								)
							const reviewed = fixture.input.report
							const published = yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									...(condition === 'single-agent'
										? { command: { agentOnly: true } }
										: {}),
									report: {
										...reviewed,
										agents: reviewed.agents.map(agent => ({
											...agent,
											...(condition === 'incomplete-agent'
												? { status: 'incomplete' as const }
												: {}),
											...(condition === 'failed-agent'
												? { status: 'failed' as const }
												: {}),
										})),
										...(condition === 'report-endpoint'
											? { endpointError: 'Unavailable' }
											: {}),
										...(condition === 'incomplete-report'
											? {
													incomplete: {
														reason: 'budget spent',
														unfinished: ['reviewer'],
													},
												}
											: {}),
									},
								})
							).pipe(Effect.provide(fixture.publisher))
							expect(published).toMatchObject({
								event: edits ? 'REQUEST_CHANGES' : 'COMMENT',
								dismissal: { dismissed: 0, failed: 0 },
							})
							expect(
								fixture.fake.writes.filter(write => write.method === 'review')
							).toHaveLength(edits ? 0 : 1)
							expect(
								fixture.fake.writes.filter(
									write => write.method === 'updateReview'
								)
							).toHaveLength(edits ? 1 : 0)
							expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
							expect(
								fixture.fake.writes.filter(
									write => write.method === 'dismissReview'
								)
							).toEqual([])
							if (
								condition === 'moved-head' ||
								condition === 'unreadable-head'
							) {
								expect(fixture.fake.reads).toContain('getPullRequest:17')
								expect(
									parseSummaryMarker(fixture.fake.reviews.at(-1)?.body ?? '')
								).toMatchObject({ runs: 5, head: fixture.head, finished: true })
							}
						})
				)
		for (const blocked of [false, true])
			test.effect(
				`a bot-authored pull request comments with blocking=${blocked} and case-insensitive REST login`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						fixture.fake.command.pullRequest = {
							...fixture.fake.command.pullRequest,
							user: { login: APP_IDENTITY.restLogin.toUpperCase() },
						}
						expect(
							yield* PublishService.use(service =>
								service.publish({
									...fixture.input,
									report: {
										...fixture.input.report,
										bugs: blocked ? [bug()] : [],
									},
								})
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({
							event: 'COMMENT',
							verdict: blocked ? 'needs fixes' : 'ready',
						})
						expect(
							fixture.fake.writes.filter(write => write.method === 'review')
						).toMatchObject([{ input: { event: 'COMMENT' } }])
					})
			)
		test.effect(
			'publish reports a refused change-request dismissal without failing the run',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture(GITHUB_ACTIONS_IDENTITY)
					fixture.fake.reviews.push(
						summaryReview(
							{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
							{ state: 'CHANGES_REQUESTED' }
						)
					)
					fixture.fake.failures.dismissReview.push(
						new GitHubApiError({
							operation: 'dismissReview',
							reason: 'Denied',
							status: 403,
						})
					)
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
					).toMatchObject({
						event: 'COMMENT',
						dismissal: { dismissed: 0, failed: 1 },
					})
				})
		)
	}
)

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'ReplyPublishService clearance evidence',
	test => {
		for (const condition of [
			'ready',
			'marker-other-head',
			'pr-other-head',
			'unreadable-head',
			'needs-fixes',
			'needs-owner',
			'incomplete',
		] as const)
			test.effect(
				`reply-only ${condition} clears only a verified ready head`,
				() =>
					Effect.gen(function* () {
						// A run off the current head never edits the change request on it; it comments.
						const posts = condition === 'ready' || condition === 'pr-other-head'
						const fixture = publishEventFixture()
						fixture.fake.reviews.push(
							summaryReview(
								{
									...SUMMARY_MARKER,
									head:
										condition === 'marker-other-head'
											? 'previous-head'
											: fixture.head,
									finished: condition !== 'incomplete',
									...(condition === 'needs-owner'
										? { needsOwner: ['thread'] }
										: {}),
								},
								{
									state: 'CHANGES_REQUESTED',
									commit: { oid: fixture.head },
									author: { __typename: 'Bot', login: APP_IDENTITY.login },
								}
							)
						)
						if (condition === 'pr-other-head')
							fixture.fake.command.pullRequest = {
								...fixture.fake.command.pullRequest,
								head: {
									...fixture.fake.command.pullRequest.head,
									sha: 'next-head',
								},
							}
						if (condition === 'unreadable-head')
							fixture.fake.failures.getPullRequest.push(
								new GitHubApiError({
									operation: 'getPullRequest',
									reason: 'Denied',
									status: 403,
								})
							)
						if (condition === 'needs-fixes')
							fixture.fake.threads.push(reviewThread())
						if (condition === 'needs-owner')
							fixture.fake.threads.push(ownerReviewThread())
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
						).toMatchObject({
							event: posts ? 'COMMENT' : 'REQUEST_CHANGES',
							dismissal: {
								dismissed: condition === 'ready' ? 1 : 0,
								failed: 0,
							},
						})
						expect(
							fixture.fake.writes.filter(write => write.method === 'review')
						).toHaveLength(posts ? 1 : 0)
						expect(
							fixture.fake.writes.filter(
								write => write.method === 'updateReview'
							)
						).toHaveLength(posts ? 0 : 1)
						expect(fixture.fake.reviews[0]?.state).toBe(
							condition === 'ready' ? 'DISMISSED' : 'CHANGES_REQUESTED'
						)
					})
			)
		test.effect(
			'reply-only reports a refused dismissal without failing the run',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						summaryReview(
							{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
							{
								state: 'CHANGES_REQUESTED',
								commit: { oid: fixture.head },
								author: { __typename: 'Bot', login: APP_IDENTITY.login },
							}
						)
					)
					fixture.fake.failures.dismissReview.push(
						new GitHubApiError({
							operation: 'dismissReview',
							reason: 'Denied',
							status: 403,
						})
					)
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
					).toMatchObject({
						event: 'COMMENT',
						dismissal: { dismissed: 0, failed: 1 },
					})
				})
		)
	}
)

/** The fixture's pull request standing on `sha`. */
function onCommit(
	fixture: ReturnType<typeof publishEventFixture>,
	sha: string
): ReturnType<typeof publishEventFixture>['fake']['command']['pullRequest'] {
	const pr = fixture.fake.command.pullRequest
	return { ...pr, head: { ...pr.head, sha } }
}

/** An own summary review on `commit` in `state`, its marker on the fixture head. */
function ownReview(
	fixture: ReturnType<typeof publishEventFixture>,
	overrides: Parameters<typeof summaryReview>[1] = {}
) {
	return summaryReview(
		{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
		{
			commit: { oid: fixture.head },
			author: { __typename: 'Bot', login: APP_IDENTITY.login },
			...overrides,
		}
	)
}

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'review state against the current head',
	test => {
		test.effect(
			'a command on an older head leaves the approval of the newer head alone',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						ownReview(fixture, {
							state: 'APPROVED',
							commit: { oid: 'next-head' },
						})
					)
					fixture.fake.command.pullRequest = onCommit(fixture, 'next-head')
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								command: { agentOnly: false },
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						event: 'COMMENT',
						dismissal: { dismissed: 0, failed: 0 },
					})
					expect(fixture.fake.reviews[0]?.state).toBe('APPROVED')
					expect(
						fixture.fake.writes.filter(
							write =>
								write.method === 'dismissReview' ||
								write.method === 'updateReview'
						)
					).toEqual([])
				})
		)
		test.effect(
			'a run on an older head never edits its approval while the pull request stands on a newer head',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(ownReview(fixture, { state: 'APPROVED' }))
					fixture.fake.command.pullRequest = onCommit(fixture, 'next-head')
					expect(
						yield* PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ event: 'COMMENT' })
					expect(
						fixture.fake.writes.filter(write => write.method === 'updateReview')
					).toEqual([])
					expect(
						fixture.fake.writes.filter(write => write.method === 'review')
					).toMatchObject([{ input: { event: 'COMMENT' } }])
				})
		)
		test.effect(
			'a push between the head check and the review write keeps the change request',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						ownReview(fixture, {
							state: 'CHANGES_REQUESTED',
							isMinimized: true,
						})
					)
					fixture.fake.pullRequestSnapshots.push(
						onCommit(fixture, fixture.head),
						onCommit(fixture, 'next-head'),
						onCommit(fixture, 'next-head')
					)
					expect(
						yield* PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						event: 'COMMENT',
						dismissal: { dismissed: 0, failed: 0 },
					})
					expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
				})
		)
		test.effect(
			'a push between the review write and the dismissals keeps the change request',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					// The previous identity's change request, which an approval would dismiss.
					fixture.fake.reviews.push(
						summaryReview(
							{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
							{ state: 'CHANGES_REQUESTED', commit: { oid: fixture.head } }
						)
					)
					fixture.fake.pullRequestSnapshots.push(
						onCommit(fixture, fixture.head),
						onCommit(fixture, fixture.head),
						onCommit(fixture, 'next-head'),
						onCommit(fixture, 'next-head')
					)
					expect(
						yield* PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						event: 'APPROVE',
						dismissal: { dismissed: 1, failed: 0 },
						outlived: true,
					})
					expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
					// The approval it just posted is for the older head, so it goes too.
					expect(fixture.fake.reviews.at(-1)?.state).toBe('DISMISSED')
				})
		)
		test.effect('a failed second thread read approves and clears nothing', () =>
			Effect.gen(function* () {
				const fixture = publishEventFixture()
				fixture.fake.reviews.push(
					ownReview(fixture, { state: 'CHANGES_REQUESTED', isMinimized: true })
				)
				fixture.fake.failures.listThreads.push(
					undefined,
					new GitHubApiError({
						operation: 'listReviewThreads',
						reason: 'Unavailable',
						status: 503,
					})
				)
				const published = yield* PublishService.use(service =>
					service.publish(fixture.input)
				).pipe(Effect.provide(fixture.publisher))
				expect(published).toMatchObject({
					event: 'COMMENT',
					dismissal: { dismissed: 0, failed: 0 },
				})
				expect(fixture.fake.threadReads).toEqual([17, 17])
				expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
				expect(
					fixture.fake.writes.filter(write => write.method === 'review')
				).toMatchObject([
					{
						input: {
							event: 'COMMENT',
							body: expect.stringContaining(
								"the bot's threads could not be read again"
							) as unknown,
						},
					},
				])
			})
		)
		test.effect(
			'a reply-only run whose second thread read fails clears nothing',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						ownReview(fixture, { state: 'CHANGES_REQUESTED' })
					)
					fixture.fake.failures.listThreads.push(
						undefined,
						new GitHubApiError({
							operation: 'listReviewThreads',
							reason: 'Unavailable',
							status: 503,
						})
					)
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
					).toMatchObject({
						verdict: 'ready',
						dismissal: { dismissed: 0, failed: 0 },
					})
					expect(fixture.fake.threadReads).toEqual([17, 17])
					expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
				})
		)
		test.effect(
			'a push between the head check and the write keeps the marker on the previous head',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						summaryReview(
							{ ...SUMMARY_MARKER, head: 'previous-head', finished: true },
							{
								commit: { oid: 'previous-head' },
								author: { __typename: 'Bot', login: APP_IDENTITY.login },
							}
						)
					)
					fixture.fake.pullRequestSnapshots.push(
						onCommit(fixture, fixture.head),
						onCommit(fixture, 'next-head'),
						onCommit(fixture, 'next-head')
					)
					expect(
						yield* PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ event: 'COMMENT' })
					expect(
						parseSummaryMarker(fixture.fake.reviews.at(-1)?.body ?? '')
					).toMatchObject({ head: 'previous-head', finished: true, runs: 2 })
				})
		)
		test.effect(
			'a reply-only run after a full review with a failed run clears nothing',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						summaryReview(
							{
								...SUMMARY_MARKER,
								head: fixture.head,
								finished: true,
								failed: true,
							},
							{
								state: 'CHANGES_REQUESTED',
								commit: { oid: fixture.head },
								author: { __typename: 'Bot', login: APP_IDENTITY.login },
							}
						)
					)
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
					).toMatchObject({
						verdict: 'ready',
						dismissal: { dismissed: 0, failed: 0 },
					})
					expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
				})
		)
		test.effect(
			'a reply-only run never revives a change request a later approval superseded',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					const marker = {
						...SUMMARY_MARKER,
						head: 'previous-head',
						finished: true,
					}
					const author = {
						__typename: 'Bot',
						login: APP_IDENTITY.login,
					} as const
					fixture.fake.reviews.push(
						summaryReview(marker, {
							databaseId: 101,
							state: 'CHANGES_REQUESTED',
							commit: { oid: 'previous-head' },
							author,
						}),
						summaryReview(marker, {
							databaseId: 102,
							state: 'APPROVED',
							commit: { oid: fixture.head },
							isMinimized: true,
							author,
						})
					)
					fixture.fake.threads.push(reviewThread())
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
					).toMatchObject({ verdict: 'needs fixes', event: 'COMMENT' })
				})
		)
		test.effect(
			'a reply-only run with a reopened bug requests changes over its approval',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(ownReview(fixture, { state: 'APPROVED' }))
					fixture.fake.threads.push(reviewThread())
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
					).toMatchObject({ verdict: 'needs fixes', event: 'REQUEST_CHANGES' })
					expect(
						fixture.fake.writes.filter(write => write.method === 'review')
					).toMatchObject([{ input: { event: 'REQUEST_CHANGES' } }])
				})
		)
	}
)

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService standing and head reads',
	test => {
		test.effect(
			'a bug thread this run closed counts open when a reply followed the closing reply',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					const open = reviewThread()
					// The second read: someone answered after the bot's closing reply, GitHub still open.
					const answered = {
						...open,
						comments: { ...open.comments, totalCount: 3 },
						latest: {
							nodes: [
								{
									databaseId: 3,
									body: 'Still racing on the second write.',
									author: { __typename: 'User', login: 'author-a' },
									editor: null,
									originalCommit: { oid: fixture.head },
								},
							],
						},
					}
					fixture.fake.threadSnapshots.push([open], [answered])
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								recheck: {
									checked: 1,
									proposals: [
										{
											threadId: open.id,
											fingerprint: bug().fingerprint,
											reason: 'The guard fixes it.',
										},
									],
									tokens: {},
								},
							})
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						verdict: 'needs fixes',
						event: 'REQUEST_CHANGES',
						openBugs: 1,
						resolved: 1,
					})
				})
		)
		test.effect(
			'a push between the head check and the write returns the standing the write rendered',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						summaryReview(
							{ ...SUMMARY_MARKER, head: 'previous-head', finished: true },
							{
								commit: { oid: 'previous-head' },
								author: { __typename: 'Bot', login: APP_IDENTITY.login },
							}
						)
					)
					fixture.fake.pullRequestSnapshots.push(
						onCommit(fixture, fixture.head),
						onCommit(fixture, 'next-head'),
						onCommit(fixture, 'next-head'),
						onCommit(fixture, 'next-head')
					)
					expect(
						yield* PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({
						verdict: 'incomplete',
						finished: false,
						event: 'COMMENT',
					})
				})
		)
		for (const pull of ['draft', 'closed'] as const)
			test.effect(
				`a clean full push on a ${pull} pull request keeps the state instead of approving`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						fixture.fake.command.pullRequest = {
							...fixture.fake.command.pullRequest,
							...(pull === 'draft' ? { draft: true } : { state: 'closed' }),
						}
						expect(
							yield* PublishService.use(service =>
								service.publish(fixture.input)
							).pipe(Effect.provide(fixture.publisher))
						).toMatchObject({ verdict: 'ready', event: 'COMMENT' })
						const reviews = fixture.fake.writes.filter(
							write => write.method === 'review'
						)
						expect(reviews).toMatchObject([{ input: { event: 'COMMENT' } }])
						const [review] = reviews
						expect(
							(review?.method === 'review' ? review.input.body : '').split(
								'\n'
							)[0]
						).toBe(
							'**Comment.** Not approved: the pull request is a draft or closed.'
						)
					})
			)
		test.effect(
			'a push after the cleanup read keeps the change request the write would clear',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						summaryReview(
							{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
							{ state: 'CHANGES_REQUESTED', commit: { oid: fixture.head } }
						)
					)
					fixture.fake.pullRequestSnapshots.push(
						onCommit(fixture, fixture.head),
						onCommit(fixture, fixture.head),
						onCommit(fixture, fixture.head),
						onCommit(fixture, 'next-head')
					)
					expect(
						yield* PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ event: 'APPROVE', outlived: true })
					expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
				})
		)
	}
)
