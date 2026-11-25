import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { REVIEW_STATE_BY_EVENT } from '../../../platform/github-review.service'
import { GitHubApiError } from '../../../platform/github.errors'
import { provideListCompleteness } from '../../../platform/list-completeness.context'
import { cleanupRepos } from '../../../shared/mocks/git-test.helper'
import { readThreadOverHttp } from '../../../shared/mocks/github-http.helper'
import {
	githubStatusFake,
	openPullRequest,
} from '../../../shared/mocks/github-status-fake.helper'
import { publishEventFixture } from '../../../shared/mocks/publish-event-test.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	appSummary,
	TOKEN_MODE_OWNED,
	bug,
	agentReport,
	reviewThread,
	summaryReview,
	SUMMARY_MARKER,
	ACCEPTING_RULES,
	RULES,
} from '../../../shared/mocks/publish-test.helper'
import {
	decidedReply,
	pendingReviewThread,
	ownerReviewThread,
	ACCEPTED_DECISION,
	unsettledBugThread,
} from '../../../shared/mocks/thread-reply-test.helper'
import {
	StatusReportService,
	StatusReportServiceLive,
} from '../../status/application/status-report.service'
import {
	StatusSweepService,
	StatusSweepServiceLive,
} from '../../status/application/status-sweep.service'
import {
	type CommitStatusText,
	toCommitStatus,
	INCOMPLETE_STATUS,
} from '../../status/domain/status.helper'
import {
	parseReplyMarker,
	parseSummaryMarker,
} from '../domain/publish-marker.parser'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import { PublishIncompleteError } from '../domain/publish.errors'
import { toIncompleteReason } from '../presentation/review-headline.formatter'
import { PublishService } from './publish.service'
import type { PublishInput } from './publish.service.types'
import { ReplyPublishService } from './reply-publish.service'
import { SummaryReviewService } from './summary-review.service'

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
							'**Comment.** Not approved: the pull request is a draft, closed or merged.'
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

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService failed head read',
	test => {
		test.effect(
			'a clean full push whose head read fails says the pull request could not be read again',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					// The first read decides the run's own head check; the write's read fails.
					fixture.fake.failures.getPullRequest.push(
						undefined,
						new GitHubApiError({
							operation: 'getPullRequest',
							reason: 'Denied',
							status: 403,
						})
					)
					expect(
						yield* PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(Effect.provide(fixture.publisher))
					).toMatchObject({ event: 'COMMENT' })
					const review = fixture.fake.writes.find(
						write => write.method === 'review'
					)
					const body = review?.method === 'review' ? review.input.body : ''
					expect(body.split('\n')[0]).toBe(
						'**Comment.** Not approved: the pull request could not be read again before the review, so the earlier state stands.'
					)
					expect(body).not.toContain('draft')
				})
		)
	}
)

/** The four lists a lenient read leaves a null node out of. */
const LENIENT_LISTS = [
	'threads',
	'thread comments',
	'comments',
	'reviews',
] as const
type LenientList = (typeof LENIENT_LISTS)[number]
type EventFixture = ReturnType<typeof publishEventFixture>
/** The name the reasons give each list. */
const LIST_NAMES = {
	threads: 'review threads',
	'thread comments': 'thread comments',
	comments: 'conversation comments',
	reviews: 'reviews',
} as const satisfies Record<LenientList, string>

/** The headline's incomplete-read reason for `list`, as it opens a longer sentence too. */
function reasonOf(list: LenientList): string {
	return toIncompleteReason([LIST_NAMES[list]]).replace(/\.$/u, '')
}

/**
 * Lists one null node in `list` on every read of the fixture: after the threads, comments or
 * reviews, or in place of the unsettled answer of a resolved bug thread read whole. The returned
 * call makes the reads complete again, the answer listed as it is.
 */
function listNullNode(fixture: EventFixture, list: LenientList): () => void {
	if (list !== 'thread comments') {
		fixture.fake.nullNodes[list] = 1
		return () => {
			fixture.fake.nullNodes[list] = 0
		}
	}
	const { thread, comments } = unsettledBugThread('outside')
	fixture.fake.threads.push(thread)
	fixture.fake.threadReader.read = readThreadOverHttp(
		comments.map(comment =>
			parseReplyMarker(comment.body)?.unsettled ? null : comment
		)
	)
	return () => {
		fixture.fake.threadReader.read = readThreadOverHttp(comments)
	}
}

/** The fixture's change request: the app's finished summary review on the head. */
function changeRequest(fixture: EventFixture) {
	return summaryReview(
		{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
		{
			state: 'CHANGES_REQUESTED',
			commit: { oid: fixture.head },
			author: { __typename: 'Bot', login: APP_IDENTITY.login },
		}
	)
}

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService incomplete list reads',
	test => {
		for (const list of LENIENT_LISTS) {
			test.effect(
				`a null node in the ${list} posts no thread for a new finding until a complete read`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						// A summary the write's read finds, so the incomplete run still writes its review.
						fixture.fake.reviews.push(summaryReview())
						const complete = listNullNode(fixture, list)
						const publishing = PublishService.use(service =>
							service.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [bug()] },
							})
						).pipe(
							Effect.provide(fixture.publisher),
							provideListCompleteness(false)
						)
						expect(yield* publishing).toMatchObject({
							onLine: 0,
							onFile: 0,
							inSummary: 1,
							incomplete: true,
						})
						// One review without inline comments, and no comment on a file.
						expect(
							fixture.fake.writes.flatMap(write =>
								write.method === 'review' ? [write.input.comments] : []
							)
						).toEqual([[]])
						expect(
							fixture.fake.writes.filter(write => write.method === 'comment')
						).toEqual([])
						complete()
						const next = yield* publishing
						expect(next).toMatchObject({ onLine: 1, inSummary: 0 })
						expect(next.incomplete).toBeUndefined()
					})
			)
			test.effect(
				`a null node in the ${list} keeps the change request and says why, and a complete read approves`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						fixture.fake.reviews.push(changeRequest(fixture))
						const complete = listNullNode(fixture, list)
						const publishing = PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(
							Effect.provide(fixture.publisher),
							provideListCompleteness(false)
						)
						// A write whose own read left a node out posts a comment beside the change request.
						const created = list === 'comments' || list === 'reviews'
						const first = yield* publishing
						expect(first).toMatchObject({
							event: created ? 'COMMENT' : 'REQUEST_CHANGES',
							dismissal: { dismissed: 0, failed: 0 },
							incomplete: true,
						})
						expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
						expect(
							fixture.fake.writes.filter(
								write =>
									write.method === 'dismissReview' ||
									(write.method === 'review' && write.input.event === 'APPROVE')
							)
						).toEqual([])
						expect(fixture.fake.reviews.at(-1)?.body).toContain(reasonOf(list))
						complete()
						const next = yield* publishing
						expect(next).toMatchObject({ event: 'APPROVE', verdict: 'ready' })
						expect(next.incomplete).toBeUndefined()
						expect(fixture.fake.reviews.at(-1)?.body).not.toContain(
							reasonOf(list)
						)
					})
			)
			test.effect(
				`a null node in the ${list} keeps an owner's wait until a complete read clears it`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						fixture.fake.reviews.push(
							summaryReview(
								{
									...SUMMARY_MARKER,
									head: fixture.head,
									finished: true,
									needsOwner: ['thread'],
								},
								{ author: { __typename: 'Bot', login: APP_IDENTITY.login } }
							)
						)
						// The unsettled thread of the thread comments case is the waiting one.
						if (list !== 'thread comments')
							fixture.fake.threads.push(
								reviewThread(undefined, {
									isResolved: true,
									resolvedBy: { login: 'contributor' },
								})
							)
						const complete = listNullNode(fixture, list)
						const publishing = PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(
							Effect.provide(fixture.publisher),
							provideListCompleteness(false)
						)
						expect(yield* publishing).toMatchObject({
							verdict: 'needs owner',
							waiting: 1,
							incomplete: true,
						})
						expect(
							parseSummaryMarker(fixture.fake.reviews.at(-1)?.body ?? '')
								?.needsOwner
						).toEqual(['thread'])
						complete()
						expect(yield* publishing).toMatchObject({ waiting: 0 })
						expect(
							parseSummaryMarker(fixture.fake.reviews.at(-1)?.body ?? '')
								?.needsOwner
						).toBeUndefined()
					})
			)
		}
		test.effect(
			'a reply-only run beside a null node dismisses no change request and says why',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(changeRequest(fixture))
					fixture.fake.nullNodes.comments = 1
					expect(
						yield* ReplyPublishService.use(service =>
							service.publish({
								pullNumber: 17,
								head: fixture.head,
								engineCommit: 'engine',
								rules: fixture.input.rules,
								replies: { base: fixture.base, tokens: {}, decisions: [] },
							})
						).pipe(
							Effect.provide(fixture.replyPublisher),
							provideListCompleteness(false)
						)
					).toMatchObject({
						dismissal: { dismissed: 0, failed: 0 },
						incomplete: true,
					})
					expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
					expect(fixture.fake.reviews.at(-1)?.body).toContain(
						reasonOf('comments')
					)
					// The write's own read left a node out, so its marker never finished: never success.
					expect(fixture.status.statuses).toEqual([
						{ sha: fixture.head, ...toCommitStatus('incomplete', 0, false) },
					])
				})
		)
		test.effect(
			'an incomplete run whose only open bug thread GitHub listed as null writes no success, a complete one does',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					// The status the head has is the newest one this spec wrote.
					const status = githubStatusFake({
						getStatus: () =>
							Effect.succeed(
								status.statuses.length === 0
									? undefined
									: {
											id: status.statuses.length,
											state: status.statuses.at(-1)?.state ?? 'pending',
											description: status.statuses.at(-1)?.description ?? '',
											context: 'MNG Review',
											creator: null,
										}
							),
					})
					fixture.fake.nullNodes.threads = 1
					// The publish run's order: the publish, then the checks and the status, in one run.
					const run = Effect.gen(function* () {
						const published = yield* PublishService.use(service =>
							service.publish(fixture.input)
						)
						yield* StatusReportService.use(service =>
							service.report({
								head: fixture.head,
								report: fixture.input.report,
								verdict: published.verdict,
								openBugs: published.openBugs,
								finished: published.finished,
							})
						)
						return published
					}).pipe(
						Effect.provide(
							Layer.merge(
								fixture.publisher,
								StatusReportServiceLive.pipe(Layer.provide(status.layer))
							)
						),
						provideListCompleteness(false)
					)
					expect(yield* run).toMatchObject({
						verdict: 'ready',
						openBugs: 0,
						incomplete: true,
					})
					expect(status.statuses).toEqual([
						{
							sha: fixture.head,
							...INCOMPLETE_STATUS,
						},
					])
					yield* run
					expect(status.statuses).toHaveLength(1)
					expect(
						status.checks.filter(check => check.conclusion === 'success')
					).toEqual([])
					fixture.fake.nullNodes.threads = 0
					expect((yield* run).incomplete).toBeUndefined()
					expect(status.statuses.at(-1)).toMatchObject({ state: 'success' })
					expect(status.checks.at(-1)?.conclusion).toBe('success')
				})
		)
		for (const list of LENIENT_LISTS)
			test.effect(
				`a null node in the ${list} posts a comment over the app's approval, and a complete run approves again`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						const approval = summaryReview(
							{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
							{
								state: 'APPROVED',
								commit: { oid: fixture.head },
								author: { __typename: 'Bot', login: APP_IDENTITY.login },
							}
						)
						fixture.fake.reviews.push(approval)
						const complete = listNullNode(fixture, list)
						const publishing = PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(
							Effect.provide(fixture.publisher),
							provideListCompleteness(false)
						)
						// The unsettled bug a null answer keeps open blocks, so the approval is withdrawn.
						const blocks = list === 'thread comments'
						expect(yield* publishing).toMatchObject({
							event: 'COMMENT',
							dismissal: { dismissed: blocks ? 1 : 0, failed: 0 },
							incomplete: true,
						})
						expect(fixture.fake.reviews).toHaveLength(2)
						expect(fixture.fake.reviews.at(-1)).toMatchObject({
							state: 'COMMENTED',
							author: { login: APP_IDENTITY.login },
						})
						expect(fixture.fake.reviews.at(-1)?.body).toContain(
							`**Comment.** Not approved: ${reasonOf(list)}`
						)
						// The approval is never edited, and dismissed only when the run blocks.
						expect(fixture.fake.reviews[0]).toMatchObject({
							state: blocks ? 'DISMISSED' : 'APPROVED',
							body: approval.body,
						})
						expect(
							fixture.fake.writes.flatMap(write =>
								write.method === 'updateReview' ||
								write.method === 'dismissReview'
									? [write.method]
									: []
							)
						).toEqual(blocks ? ['dismissReview'] : [])
						complete()
						expect(yield* publishing).toMatchObject({ event: 'APPROVE' })
						expect(fixture.fake.reviews.at(-1)?.state).toBe('APPROVED')
					})
			)
	}
)

/**
 * A newer summary review with no wait over the app's old sticky comment that stores `thread`'s
 * wait; a contributor without owner access resolved the thread, so the wait stands.
 */
function stickyWait(fixture: EventFixture) {
	const marker = { ...SUMMARY_MARKER, head: fixture.head, finished: true }
	fixture.fake.reviews.push(
		summaryReview(marker, {
			author: { __typename: 'Bot', login: APP_IDENTITY.login },
		})
	)
	fixture.fake.comments.push(appSummary({ ...marker, needsOwner: ['thread'] }))
	fixture.fake.threads.push(
		reviewThread(undefined, {
			isResolved: true,
			resolvedBy: { login: 'contributor' },
		})
	)
	fixture.fake.command.role = 'write'
}

/** The fixture's summary review with `thread` waiting for the owner, which a contributor resolved. */
function ownerWait(fixture: EventFixture) {
	fixture.fake.reviews.push(
		summaryReview(
			{
				...SUMMARY_MARKER,
				head: fixture.head,
				finished: true,
				needsOwner: ['thread'],
			},
			{ author: { __typename: 'Bot', login: APP_IDENTITY.login } }
		)
	)
	fixture.fake.threads.push(
		reviewThread(undefined, {
			isResolved: true,
			resolvedBy: { login: 'contributor' },
		})
	)
}

/** The `needs-owner` wait the newest summary review's marker stores. */
function storedWait(fixture: EventFixture) {
	return parseSummaryMarker(fixture.fake.reviews.at(-1)?.body ?? '')?.needsOwner
}

/** The inline comments of every review the fixture's runs posted. */
function inlineComments(fixture: EventFixture) {
	return fixture.fake.writes.flatMap(write =>
		write.method === 'review' ? [write.input.comments.length] : []
	)
}

/** A review create GitHub answered with a 503, which it may still have accepted. */
function unavailableCreate() {
	return new GitHubApiError({
		operation: 'createReview',
		reason: 'Unavailable',
		status: 503,
	})
}

/** A write GitHub refused with a 403. */
function forbidden(
	operation: 'createReview' | 'updateReview' | 'minimizeComment'
) {
	return new GitHubApiError({ operation, reason: 'Forbidden', status: 403 })
}

/** A `success` the head already has, as an earlier complete run left it. */
function seedSuccess(fixture: EventFixture) {
	fixture.status.seeded.set(fixture.head, {
		id: 1,
		state: 'success',
		description: 'ready',
		context: 'MNG Review',
		creator: null,
	})
}

/** The fixture's full publish, with list completeness tracked as the action tracks it. */
function publishFull(fixture: EventFixture) {
	return PublishService.use(service => service.publish(fixture.input)).pipe(
		Effect.provide(fixture.publisher),
		provideListCompleteness(false)
	)
}

/** The fixture's full publish of `input` and then its checks and status, as the publish run does them. */
function publishAndReport(
	fixture: EventFixture,
	input: PublishInput = fixture.input
) {
	return Effect.gen(function* () {
		const published = yield* PublishService.use(service =>
			service.publish(input)
		)
		yield* StatusReportService.use(service =>
			service.report({ ...published, head: input.head, report: input.report })
		)
		return published
	}).pipe(
		Effect.provide(
			Layer.merge(
				fixture.publisher,
				StatusReportServiceLive.pipe(Layer.provide(fixture.status.layer))
			)
		),
		provideListCompleteness(false)
	)
}

/** The fixture's reply-only publish with no decision, with list completeness tracked. */
function publishReplies(fixture: EventFixture) {
	return ReplyPublishService.use(service =>
		service.publish({
			pullNumber: 17,
			head: fixture.head,
			engineCommit: 'engine',
			rules: fixture.input.rules,
			replies: { base: fixture.base, tokens: {}, decisions: [] },
		})
	).pipe(Effect.provide(fixture.replyPublisher), provideListCompleteness(false))
}

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService reads that drop a node late in the run',
	test => {
		for (const list of ['comments', 'reviews'] as const) {
			test.effect(
				`a null node only in the write's own ${list} read keeps the owner's wait and the label`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						ownerWait(fixture)
						// The waiting list's read is complete; the summary write's own read is not.
						fixture.fake.nullNodes.queued[list].push(0, 1)
						const publishing = PublishService.use(service =>
							service.publish(fixture.input)
						).pipe(
							Effect.provide(fixture.publisher),
							provideListCompleteness(false)
						)
						expect(yield* publishing).toMatchObject({
							verdict: 'needs owner',
							waiting: 1,
							incomplete: true,
						})
						expect(storedWait(fixture)).toEqual(['thread'])
						expect(
							fixture.fake.writes.filter(write => write.method === 'unlabel')
						).toEqual([])
						expect(yield* publishing).toMatchObject({ waiting: 0 })
						expect(storedWait(fixture)).toBeUndefined()
						expect(
							fixture.fake.writes.filter(write => write.method === 'unlabel')
						).toHaveLength(1)
					})
			)
			test.effect(
				`a null node only in the write's own ${list} read keeps a reply-only run's wait and the label`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						ownerWait(fixture)
						fixture.fake.nullNodes.queued[list].push(0, 1)
						const publishing = ReplyPublishService.use(service =>
							service.publish({
								pullNumber: 17,
								head: fixture.head,
								engineCommit: 'engine',
								rules: fixture.input.rules,
								replies: { base: fixture.base, tokens: {}, decisions: [] },
							})
						).pipe(
							Effect.provide(fixture.replyPublisher),
							provideListCompleteness(false)
						)
						expect(yield* publishing).toMatchObject({
							verdict: 'needs owner',
							waiting: 1,
							incomplete: true,
						})
						expect(storedWait(fixture)).toEqual(['thread'])
						expect(
							fixture.fake.writes.filter(write => write.method === 'unlabel')
						).toEqual([])
						expect(yield* publishing).toMatchObject({ waiting: 0 })
						expect(storedWait(fixture)).toBeUndefined()
					})
			)
		}
		test.effect(
			"a null node only in the write's own review read attaches no inline comment",
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					// A summary the write's read finds, so the incomplete run still writes its review.
					fixture.fake.reviews.push(summaryReview())
					fixture.fake.nullNodes.queued.reviews.push(0, 1)
					const publishing = PublishService.use(service =>
						service.publish({
							...fixture.input,
							report: { ...fixture.input.report, bugs: [bug()] },
						})
					).pipe(
						Effect.provide(fixture.publisher),
						provideListCompleteness(false)
					)
					expect(yield* publishing).toMatchObject({
						onLine: 0,
						inSummary: 1,
						incomplete: true,
					})
					expect(inlineComments(fixture)).toEqual([0])
					expect(yield* publishing).toMatchObject({ onLine: 1, inSummary: 0 })
					expect(inlineComments(fixture)).toEqual([0, 1])
				})
		)
		test.effect(
			'a null node only in the second thread read posts no comment on a file',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.nullNodes.queued.threads.push(0, 1)
					const publishing = PublishService.use(service =>
						service.publish({
							...fixture.input,
							report: { ...fixture.input.report, bugs: [bug({ line: 2 })] },
						})
					).pipe(
						Effect.provide(fixture.publisher),
						provideListCompleteness(false)
					)
					expect(yield* publishing).toMatchObject({
						onFile: 0,
						inSummary: 1,
						incomplete: true,
					})
					expect(
						fixture.fake.writes.filter(write => write.method === 'comment')
					).toEqual([])
					expect(yield* publishing).toMatchObject({ onFile: 1, inSummary: 0 })
					expect(
						fixture.fake.writes.filter(write => write.method === 'comment')
					).toHaveLength(1)
				})
		)
		test.effect(
			'a finding whose own thread GitHub listed as null goes into the summary, then counts as repeated once',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.threads.push(reviewThread())
					// Both thread reads of the first run list the bot's thread as a null node.
					fixture.fake.threadSnapshots.push([], [])
					fixture.fake.nullNodes.queued.threads.push(1, 1)
					const publishing = PublishService.use(service =>
						service.publish({
							...fixture.input,
							report: { ...fixture.input.report, bugs: [bug()] },
						})
					).pipe(
						Effect.provide(fixture.publisher),
						provideListCompleteness(false)
					)
					expect(yield* publishing).toMatchObject({
						onLine: 0,
						onFile: 0,
						inSummary: 1,
						repeated: 0,
						incomplete: true,
					})
					const next = yield* publishing
					expect(next).toMatchObject({
						onLine: 0,
						onFile: 0,
						inSummary: 0,
						repeated: 1,
					})
					expect(next.incomplete).toBeUndefined()
					expect(yield* publishing).toMatchObject({
						onLine: 0,
						onFile: 0,
						inSummary: 0,
						repeated: 1,
					})
					// The thread is never posted again, inline or on its file.
					expect(
						inlineComments(fixture).every(count => count === 0)
					).toBeTruthy()
					expect(
						fixture.fake.writes.filter(write => write.method === 'comment')
					).toEqual([])
				})
		)
		for (const path of ['full', 'reply-only'] as const)
			test.effect(
				`an incomplete ${path} run keeps the sticky comment whose wait it could not read`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						stickyWait(fixture)
						// The waiting list's read lists the sticky comment as null; the write's own read sees it.
						fixture.fake.commentSnapshots.push([])
						fixture.fake.nullNodes.queued.comments.push(1)
						// GitHub refuses to hide the comment, which a cleanup answers with a delete.
						fixture.fake.failures.minimize.push(forbidden('minimizeComment'))
						const publishing =
							path === 'full'
								? publishAndReport(fixture)
								: publishReplies(fixture)
						expect(yield* publishing).toMatchObject({ incomplete: true })
						expect(
							fixture.fake.writes.filter(
								write =>
									write.method === 'minimize' || write.method === 'delete'
							)
						).toEqual([])
						expect(fixture.fake.comments).toMatchObject([
							{ id: 'app-summary', isMinimized: false },
						])
						const next = yield* publishing
						expect(next.incomplete).toBeUndefined()
						expect(next).toMatchObject({ verdict: 'needs owner', waiting: 1 })
						expect(storedWait(fixture)).toEqual(['thread'])
						expect(
							fixture.status.statuses.filter(
								status => status.state === 'success'
							)
						).toEqual([])
					})
			)
		test.effect(
			"an incomplete run on a new head dismisses the app's approval of the earlier head and lifts no change request",
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					const earlier = { ...SUMMARY_MARKER, head: 'earlier', finished: true }
					fixture.fake.reviews.push(
						summaryReview(earlier, {
							id: 'request',
							databaseId: 201,
							state: 'CHANGES_REQUESTED',
							commit: { oid: 'earlier' },
						}),
						summaryReview(earlier, {
							id: 'approval',
							databaseId: 202,
							state: 'APPROVED',
							commit: { oid: 'earlier' },
							author: { __typename: 'Bot', login: APP_IDENTITY.login },
						})
					)
					fixture.fake.nullNodes.threads = 1
					const publishing = PublishService.use(service =>
						service.publish(fixture.input)
					).pipe(
						Effect.provide(fixture.publisher),
						provideListCompleteness(false)
					)
					expect(yield* publishing).toMatchObject({
						dismissal: { dismissed: 1, failed: 0 },
						incomplete: true,
					})
					expect(
						fixture.fake.writes.flatMap(write =>
							write.method === 'dismissReview' ? [write.id] : []
						)
					).toEqual([202])
					expect(fixture.fake.reviews[0]?.state).toBe('CHANGES_REQUESTED')
					fixture.fake.nullNodes.threads = 0
					yield* publishing
					expect(fixture.fake.reviews[0]?.state).toBe('DISMISSED')
				})
		)
		for (const nulls of [0, 1])
			test.effect(
				nulls === 0
					? 'a transient review create that a complete read confirms approves and clears the wait'
					: 'a transient review create whose confirming read drops a node but lists the approval counts, approves and clears the wait',
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture(APP_IDENTITY, {
							storeFailedCreates: true,
						})
						ownerWait(fixture)
						fixture.fake.failures.review.push(unavailableCreate())
						// The waiting list's and the write's own review reads are complete; the confirming one may not be.
						fixture.fake.nullNodes.queued.reviews.push(0, 0, nulls)
						const published = yield* publishAndReport(fixture)
						// The decision came from complete reads; the confirming read only finds the review.
						expect(published).toMatchObject({ event: 'APPROVE', waiting: 0 })
						expect(published.incomplete).toBeUndefined()
						expect(fixture.fake.reviews.at(-1)?.state).toBe('APPROVED')
						expect(storedWait(fixture)).toBeUndefined()
						expect(fixture.status.statuses).toMatchObject([
							{ sha: fixture.head, state: 'success' },
						])
					})
			)
		test.effect(
			'a transient review create whose confirming read lists the new review as its null node fails unconfirmed',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture(APP_IDENTITY, {
						storeFailedCreates: true,
					})
					fixture.fake.failures.review.push(unavailableCreate())
					// Every review read before the create sees the reviews as they are; the confirming read
					// lists the same ones and a null node where the new review is.
					fixture.fake.reviewSnapshots.push(
						[...fixture.fake.reviews],
						[...fixture.fake.reviews],
						[...fixture.fake.reviews]
					)
					fixture.fake.nullNodes.queued.reviews.push(0, 0, 1)
					expect(yield* publishFull(fixture).pipe(Effect.flip)).toBeInstanceOf(
						PublishIncompleteError
					)
					// As before the incomplete reads: one review, nothing dismissed, no later write.
					expect(
						fixture.fake.writes.flatMap(write =>
							write.method === 'review' || write.method === 'dismissReview'
								? [write.method]
								: []
						)
					).toEqual(['review'])
				})
		)
		for (const nulls of [0, 1])
			test.effect(
				nulls === 0
					? "a reply-only run's transient review create that a complete read confirms clears the wait"
					: "a reply-only run's transient review create whose confirming read drops a node but lists the review counts and clears the wait",
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture(APP_IDENTITY, {
							storeFailedCreates: true,
						})
						ownerWait(fixture)
						// A change request on the head, so the clearing run posts a review instead of editing.
						fixture.fake.reviews[0] = {
							...changeRequest(fixture),
							body: fixture.fake.reviews[0]?.body ?? '',
						}
						fixture.fake.failures.review.push(unavailableCreate())
						fixture.fake.nullNodes.queued.reviews.push(0, 0, nulls)
						const published = yield* publishReplies(fixture)
						expect(published).toMatchObject({ verdict: 'ready', waiting: 0 })
						expect(published.incomplete).toBeUndefined()
						expect(fixture.fake.reviews).toHaveLength(2)
						expect(fixture.fake.reviews[0]?.state).toBe('DISMISSED')
						expect(storedWait(fixture)).toBeUndefined()
					})
			)
		for (const scenario of [
			{ bug: true, seeded: true, state: 'failure' },
			{ bug: false, seeded: true, state: 'pending' },
			{ bug: false, seeded: false, state: 'pending' },
		] as const)
			test.effect(
				scenario.bug
					? "an incomplete reply-only run's failed write over an open bug it saw turns a success into failure"
					: `a clean incomplete reply-only run's failed write sets pending ${scenario.seeded ? 'over a success' : 'on a head with no status'}`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						if (scenario.seeded) seedSuccess(fixture)
						// No wait. Each prior review differs from the posted state, so the run creates one.
						if (scenario.bug) {
							fixture.fake.reviews.push(
								summaryReview(
									{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
									{ author: { __typename: 'Bot', login: APP_IDENTITY.login } }
								)
							)
							fixture.fake.threads.push(
								reviewThread({ finding: bug(), kind: 'bug' })
							)
						} else fixture.fake.reviews.push(changeRequest(fixture))
						fixture.fake.nullNodes.threads = 1
						// Whichever write the run makes, GitHub refuses it.
						fixture.fake.failures.review.push(forbidden('createReview'))
						fixture.fake.failures.updateReview.push(forbidden('updateReview'))
						expect(
							yield* publishReplies(fixture).pipe(Effect.flip)
						).toBeInstanceOf(GitHubApiError)
						expect(fixture.status.statuses).toMatchObject([
							scenario.bug
								? { sha: fixture.head, state: 'failure' }
								: {
										sha: fixture.head,
										...INCOMPLETE_STATUS,
									},
						])
					})
			)
		test.effect(
			"an incomplete reply-only run whose write fails before rendering counts the marker's unthreaded bugs",
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					seedSuccess(fixture)
					fixture.fake.reviews.push(
						summaryReview(
							{
								...SUMMARY_MARKER,
								head: fixture.head,
								finished: true,
								unthreadedBugs: 1,
							},
							{ author: { __typename: 'Bot', login: APP_IDENTITY.login } }
						)
					)
					fixture.fake.nullNodes.threads = 1
					// The waiting list's review read passes; the write's own fails before it renders.
					fixture.fake.failures.listReviews.push(
						undefined,
						new GitHubApiError({
							operation: 'listReviews',
							reason: 'Unavailable',
							status: 503,
						})
					)
					expect(
						yield* publishReplies(fixture).pipe(Effect.flip)
					).toBeInstanceOf(GitHubApiError)
					expect(fixture.status.statuses).toMatchObject([
						{ sha: fixture.head, state: 'failure' },
					])
				})
		)
		test.effect(
			'a complete reply-only run whose write fails before rendering keeps the label once the recovery read drops a node',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					// The run clears the last wait, which a contributor resolved.
					ownerWait(fixture)
					// The waiting list's review read passes, the write's own fails before it renders, and the
					// recovery read of the newest marker lists a null node.
					fixture.fake.failures.listReviews.push(
						undefined,
						new GitHubApiError({
							operation: 'listReviews',
							reason: 'Unavailable',
							status: 503,
						})
					)
					fixture.fake.nullNodes.queued.reviews.push(0, 1)
					expect(
						yield* publishReplies(fixture).pipe(Effect.flip)
					).toBeInstanceOf(GitHubApiError)
					expect(
						fixture.fake.writes.filter(write => write.method === 'unlabel')
					).toEqual([])
				})
		)
	}
)

/** The app's approval of the fixture's head, under a finished summary marker. */
function headApproval(fixture: EventFixture, needsOwner?: readonly string[]) {
	return summaryReview(
		{
			...SUMMARY_MARKER,
			head: fixture.head,
			finished: true,
			...(needsOwner ? { needsOwner } : {}),
		},
		{
			state: 'APPROVED',
			commit: { oid: fixture.head },
			author: { __typename: 'Bot', login: APP_IDENTITY.login },
		}
	)
}

/** The app's newest summary as a run left it: counts no earlier marker would carry. */
const KEPT_MARKER = {
	...SUMMARY_MARKER,
	runs: 3,
	manualRuns: 2,
	finished: true,
	unthreadedBugs: 1,
} as const

/** The fixture's summary review with `KEPT_MARKER`, which only the waiting read lists. */
function summaryOnlyWaitingSees(fixture: EventFixture) {
	const summary = summaryReview(
		{ ...KEPT_MARKER, head: fixture.head },
		{ author: { __typename: 'Bot', login: APP_IDENTITY.login } }
	)
	fixture.fake.reviews.push(summary)
	// The waiting read lists the summary; the write's own read lists a null node in its place.
	fixture.fake.reviewSnapshots.push([summary], [])
	fixture.fake.nullNodes.queued.reviews.push(0, 1)
	return summary
}

/** The review writes the fixture's runs made: creates, edits and dismissals. */
function reviewWrites(fixture: EventFixture) {
	return fixture.fake.writes.filter(
		write =>
			write.method === 'review' ||
			write.method === 'updateReview' ||
			write.method === 'dismissReview'
	)
}

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService incomplete runs that block',
	test => {
		for (const list of LENIENT_LISTS)
			test.effect(
				`a null node in the ${list} with a new bug dismisses the app's approval of the head`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						fixture.fake.reviews.push(headApproval(fixture))
						listNullNode(fixture, list)
						const published = yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [bug()] },
							})
						).pipe(
							Effect.provide(fixture.publisher),
							provideListCompleteness(false)
						)
						expect(published).toMatchObject({
							verdict: 'needs fixes',
							event: 'COMMENT',
							dismissal: { dismissed: 1, failed: 0 },
							incomplete: true,
						})
						expect(fixture.fake.reviews[0]?.state).toBe('DISMISSED')
						expect(fixture.fake.reviews.at(-1)).toMatchObject({
							state: 'COMMENTED',
							author: { login: APP_IDENTITY.login },
						})
					})
			)
		test.effect(
			"a reply-only run beside a null node with a thread waiting for the owner dismisses the app's approval of the head",
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(headApproval(fixture, ['thread']))
					fixture.fake.threads.push(
						reviewThread(undefined, {
							isResolved: true,
							resolvedBy: { login: 'contributor' },
						})
					)
					fixture.fake.nullNodes.comments = 1
					expect(yield* publishReplies(fixture)).toMatchObject({
						verdict: 'needs owner',
						dismissal: { dismissed: 1, failed: 0 },
						incomplete: true,
					})
					expect(fixture.fake.reviews[0]?.state).toBe('DISMISSED')
				})
		)
		test.effect(
			"an incomplete run whose head is no longer current keeps the app's approval of the current head",
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					// A push landed and a newer run approved it before this run's write.
					fixture.fake.reviews.push({
						...headApproval(fixture),
						commit: { oid: 'pushed' },
					})
					fixture.fake.command.pullRequest = {
						...fixture.fake.command.pullRequest,
						head: { ...fixture.fake.command.pullRequest.head, sha: 'pushed' },
					}
					fixture.fake.nullNodes.threads = 1
					yield* PublishService.use(service =>
						service.publish({
							...fixture.input,
							report: { ...fixture.input.report, bugs: [bug()] },
						})
					).pipe(
						Effect.provide(fixture.publisher),
						provideListCompleteness(false)
					)
					expect(fixture.fake.reviews[0]?.state).toBe('APPROVED')
				})
		)
	}
)

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService summaries an incomplete read cannot find',
	test => {
		test.effect(
			'a full run whose write cannot find the summary writes an unfinished one, and the next complete run counts on',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					summaryOnlyWaitingSees(fixture)
					expect(yield* publishFull(fixture)).toMatchObject({
						incomplete: true,
						event: 'COMMENT',
					})
					expect(newestMarker(fixture)).toMatchObject({
						finished: false,
						failed: true,
					})
					// A complete run counts from the summary the incomplete write missed.
					yield* publishFull(fixture)
					expect(newestMarker(fixture)).toMatchObject({
						runs: 4,
						manualRuns: 2,
						finished: true,
					})
					expect(newestMarker(fixture)?.failed).toBeUndefined()
				})
		)
		test.effect(
			'a reply-only run whose write cannot find the summary writes an unfinished one that the next reply-only run keeps',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					summaryOnlyWaitingSees(fixture)
					expect(yield* publishReplies(fixture)).toMatchObject({
						incomplete: true,
					})
					expect(reviewWrites(fixture).map(write => write.method)).toEqual([
						'review',
					])
					expect(yield* publishReplies(fixture)).toMatchObject({
						verdict: 'incomplete',
					})
					expect(newestMarker(fixture)).toMatchObject({
						runs: 3,
						manualRuns: 2,
						finished: false,
						failed: true,
					})
				})
		)
		test.effect(
			'an incomplete reply-only run whose status read fails says so in its result',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture(
						APP_IDENTITY,
						{},
						{
							getStatus: () =>
								Effect.fail(
									new GitHubApiError({
										operation: 'getStatus',
										reason: 'Denied',
									})
								),
						}
					)
					// A finished summary on the head, so the standing is ready and its status a held success.
					fixture.fake.reviews.push(
						summaryReview(
							{ ...SUMMARY_MARKER, head: fixture.head, finished: true },
							{ author: { __typename: 'Bot', login: APP_IDENTITY.login } }
						)
					)
					fixture.fake.nullNodes.threads = 1
					// The incomplete run leaves the summary unfinished, whose status it cannot read.
					expect(yield* publishReplies(fixture)).toMatchObject({
						verdict: 'incomplete',
						status: false,
						statusUnread: true,
						incomplete: true,
					})
					expect(fixture.status.statuses).toEqual([])
				})
		)
	}
)

/** The marker of the newest review on the fixture's pull request. */
function newestMarker(fixture: EventFixture) {
	return parseSummaryMarker(fixture.fake.reviews.at(-1)?.body ?? '')
}

/** The fixture head's `MNG Review` status as a run left it, which the sweep and later runs read. */
function seedStatus(fixture: EventFixture, text: CommitStatusText) {
	fixture.status.seeded.set(fixture.head, {
		id: 1,
		...text,
		context: 'MNG Review',
		creator: null,
	})
}

/** A complete status sweep of the fixture's pull request over its seeded status, with what it wrote. */
function sweepComplete(fixture: EventFixture) {
	const statuses = githubStatusFake({
		listOpenPullRequests: () =>
			Effect.succeed([openPullRequest(17, fixture.head)]),
		getStatus: head => Effect.succeed(fixture.status.seeded.get(head)),
	})
	return StatusSweepService.use(service => service.sweep()).pipe(
		Effect.provide(
			StatusSweepServiceLive.pipe(
				Layer.provide(Layer.merge(fixture.fake.api, statuses.layer))
			)
		),
		provideListCompleteness(false),
		Effect.map(result => ({ result, statuses: statuses.statuses }))
	)
}

/**
 * An older hidden summary that finished clean and the app's newest summary, a change request on the
 * head with a bug without a thread and higher counts. The waiting read lists both; the summary
 * write's own read lists the older one and a null node in place of the newest.
 */
function droppedNewest(fixture: EventFixture) {
	const author = { __typename: 'Bot', login: APP_IDENTITY.login } as const
	const older = summaryReview(
		{
			...SUMMARY_MARKER,
			runs: 5,
			manualRuns: 1,
			head: fixture.head,
			finished: true,
		},
		{ id: 'older', databaseId: 201, isMinimized: true, author }
	)
	const newest = summaryReview(
		{
			...SUMMARY_MARKER,
			runs: 7,
			manualRuns: 3,
			head: fixture.head,
			finished: true,
			unthreadedBugs: 1,
		},
		{
			id: 'newest',
			databaseId: 202,
			state: 'CHANGES_REQUESTED',
			commit: { oid: fixture.head },
			author,
		}
	)
	fixture.fake.reviews.push(older, newest)
	fixture.fake.reviewSnapshots.push([older, newest], [older])
	fixture.fake.nullNodes.queued.reviews.push(0, 1)
	seedStatus(fixture, toCommitStatus('needs fixes', 1, true))
	return newest
}

/** The marker every cap reads (`readPrior`), over a complete read of the fixture's pull request. */
function readPrior(fixture: EventFixture) {
	return SummaryReviewService.use(service => service.readPrior(17)).pipe(
		Effect.provide(fixture.summary)
	)
}

/** The state of the review with `databaseId` on the fixture's pull request now. */
function stateOf(fixture: EventFixture, databaseId: number) {
	return fixture.fake.reviews.find(review => review.databaseId === databaseId)
		?.state
}

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService summaries an incomplete write left unfinished',
	test => {
		test.effect(
			'a first review whose summary read drops a comment still blocks a complete sweep',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.nullNodes.comments = 1
					expect(
						yield* PublishService.use(service =>
							service.publish({
								...fixture.input,
								report: { ...fixture.input.report, bugs: [bug()] },
							})
						).pipe(
							Effect.provide(fixture.publisher),
							provideListCompleteness(false)
						)
					).toMatchObject({ verdict: 'needs fixes', incomplete: true })
					// The run's findings are in a summary marked unfinished.
					expect(newestMarker(fixture)).toMatchObject({
						head: fixture.head,
						unthreadedBugs: 1,
						finished: false,
						failed: true,
					})
					seedStatus(fixture, toCommitStatus('needs fixes', 1, true))
					fixture.fake.nullNodes.comments = 0
					const swept = yield* sweepComplete(fixture)
					expect(swept.statuses.map(status => status.state)).not.toContain(
						'success'
					)
				})
		)
		test.effect(
			'an incomplete write over an older summary holds a later complete reply-only run',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					const newest = droppedNewest(fixture)
					expect(yield* publishReplies(fixture)).toMatchObject({
						incomplete: true,
					})
					expect(newestMarker(fixture)).toMatchObject({
						finished: false,
						failed: true,
					})
					const replied = yield* publishReplies(fixture)
					expect(replied.verdict).not.toBe('ready')
					expect(replied.incomplete).toBeUndefined()
					// Nothing blocks, so the head keeps its `failure`; the change request stands.
					expect(fixture.status.statuses).toEqual([])
					expect(stateOf(fixture, newest.databaseId ?? 0)).toBe(
						'CHANGES_REQUESTED'
					)
				})
		)
		test.effect(
			'an incomplete write over an older summary holds a later complete sweep',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					const newest = droppedNewest(fixture)
					yield* publishReplies(fixture)
					const swept = yield* sweepComplete(fixture)
					expect(swept.statuses.map(status => status.state)).not.toContain(
						'success'
					)
					expect(stateOf(fixture, newest.databaseId ?? 0)).toBe(
						'CHANGES_REQUESTED'
					)
				})
		)
		test.effect(
			'a complete full run after an incomplete write counts the runs of the summary it missed',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					droppedNewest(fixture)
					yield* publishReplies(fixture)
					expect(newestMarker(fixture)).toMatchObject({
						runs: 5,
						manualRuns: 1,
					})
					// What every cap reads never goes below the count the dropped summary held.
					expect(yield* readPrior(fixture)).toMatchObject({
						runs: 7,
						manualRuns: 3,
					})
					yield* publishFull(fixture)
					expect(newestMarker(fixture)).toMatchObject({
						runs: 8,
						manualRuns: 3,
						finished: true,
					})
					expect(yield* readPrior(fixture)).toMatchObject({
						runs: 8,
						manualRuns: 3,
					})
				})
		)
		for (const [previous, written] of [
			['failure', []],
			['success', ['error']],
		] as const)
			test.effect(
				`a reply-only run on an unfinished summary with nothing blocking over a ${previous} writes ${written.length === 0 ? 'no status' : written[0]}`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						fixture.fake.reviews.push(
							summaryReview(
								{
									...SUMMARY_MARKER,
									head: fixture.head,
									finished: false,
									failed: true,
								},
								{ author: { __typename: 'Bot', login: APP_IDENTITY.login } }
							)
						)
						seedStatus(
							fixture,
							previous === 'failure'
								? toCommitStatus('needs owner', 0, true)
								: toCommitStatus('ready', 0, true)
						)
						expect(yield* publishReplies(fixture)).toMatchObject({
							verdict: 'incomplete',
						})
						expect(fixture.status.statuses.map(status => status.state)).toEqual(
							written
						)
					})
			)
	}
)

/** The app's summary review with `marker` on the fixture's head. */
function appReview(
	fixture: EventFixture,
	marker: Partial<SummaryMarker>,
	databaseId = 101
) {
	return summaryReview(
		{ ...SUMMARY_MARKER, head: fixture.head, ...marker },
		{
			id: `summary-${databaseId}`,
			databaseId,
			author: { __typename: 'Bot', login: APP_IDENTITY.login },
		}
	)
}

/** An unfinished marker an incomplete write left on the head, with both run caps reached. */
const CAPPED_HOLD = {
	runs: RULES.config.limits.max_runs_per_pr,
	manualRuns: RULES.config.commands.max_runs,
	finished: false,
	failed: true,
} as const

layer(APP_MODE_OWNED, { excludeTestServices: true })(
	'PublishService holds no run can get around',
	test => {
		test.effect(
			'an incomplete write that cannot see the newest of two summaries creates a review, so a complete sweep holds',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					const older = appReview(fixture, { runs: 2, finished: true })
					const newer = appReview(fixture, { runs: 3, finished: true }, 102)
					fixture.fake.reviews.push(older, newer)
					// The waiting read lists both; the write's own lists a null node in place of the newer.
					fixture.fake.reviewSnapshots.push([older, newer], [older])
					fixture.fake.nullNodes.queued.reviews.push(0, 1)
					expect(yield* publishReplies(fixture)).toMatchObject({
						incomplete: true,
					})
					expect(reviewWrites(fixture).map(write => write.method)).toEqual([
						'review',
					])
					expect(newestMarker(fixture)).toMatchObject({
						finished: false,
						failed: true,
					})
					seedStatus(fixture, toCommitStatus('incomplete', 0, false))
					const swept = yield* sweepComplete(fixture)
					expect(swept.statuses.map(status => status.state)).not.toContain(
						'success'
					)
				})
		)
		test.effect(
			'a full run that finishes after an earlier read dropped a node keeps the hold',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						appReview(fixture, {
							runs: 2,
							finished: false,
							failed: true,
							unthreadedBugs: 1,
						})
					)
					// Only the thread read leaves a node out; the summary write's own read is complete.
					fixture.fake.nullNodes.threads = 1
					expect(yield* publishFull(fixture)).toMatchObject({
						incomplete: true,
					})
					expect(newestMarker(fixture)).toMatchObject({
						runs: 3,
						finished: false,
						failed: true,
					})
					fixture.fake.nullNodes.threads = 0
					yield* publishFull(fixture)
					expect(newestMarker(fixture)).toMatchObject({
						runs: 4,
						finished: true,
					})
					expect(newestMarker(fixture)?.failed).toBeUndefined()
				})
		)
		test.effect(
			'a review command past both run caps is reserved over an unfinished summary and its complete run clears it',
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(appReview(fixture, CAPPED_HOLD))
					expect(
						yield* SummaryReviewService.use(service =>
							service.reserveManualRun({
								pullNumber: 17,
								head: fixture.head,
								engineCommit: 'engine',
								maxRuns: RULES.config.commands.max_runs,
								handle: 'review-bot',
							})
						).pipe(Effect.provide(fixture.summary))
					).toBeTruthy()
					yield* PublishService.use(service =>
						service.publish({
							...fixture.input,
							command: { agentOnly: false },
						})
					).pipe(Effect.provide(fixture.publisher))
					expect(newestMarker(fixture)).toMatchObject({
						runs: CAPPED_HOLD.runs + 1,
						manualRuns: CAPPED_HOLD.manualRuns + 1,
						finished: true,
					})
					expect(newestMarker(fixture)?.failed).toBeUndefined()
				})
		)
		for (const run of ['one-agent', 'unfinished full'] as const)
			for (const [previous, written] of [
				['failure', []],
				['success', ['error']],
			] as const)
				test.effect(
					`a complete ${run} run over an unfinished summary with nothing blocking over a ${previous} writes ${written.length === 0 ? 'no status' : written[0]}`,
					() =>
						Effect.gen(function* () {
							const fixture = publishEventFixture()
							fixture.fake.reviews.push(
								appReview(fixture, { finished: false, failed: true })
							)
							seedStatus(
								fixture,
								previous === 'failure'
									? toCommitStatus('needs owner', 0, true)
									: toCommitStatus('ready', 0, true)
							)
							const input: PublishInput =
								run === 'one-agent'
									? { ...fixture.input, command: { agentOnly: true } }
									: {
											...fixture.input,
											report: {
												...fixture.input.report,
												endpointError: 'offline',
											},
										}
							// Neither run replaces the marker, so it keeps the hold an incomplete write left.
							expect(yield* publishAndReport(fixture, input)).toMatchObject({
								finished: false,
								held: true,
							})
							expect(
								fixture.status.statuses.map(status => status.state)
							).toEqual(written)
						})
				)
		test.effect(
			"an incomplete reply-only run's failed write over an unfinished summary keeps a failure",
			() =>
				Effect.gen(function* () {
					const fixture = publishEventFixture()
					fixture.fake.reviews.push(
						appReview(fixture, { finished: false, failed: true })
					)
					seedStatus(fixture, toCommitStatus('needs owner', 0, true))
					fixture.fake.nullNodes.threads = 1
					fixture.fake.failures.review.push(forbidden('createReview'))
					fixture.fake.failures.updateReview.push(forbidden('updateReview'))
					expect(
						yield* publishReplies(fixture).pipe(Effect.flip)
					).toBeInstanceOf(GitHubApiError)
					expect(fixture.status.statuses).toEqual([])
				})
		)
		for (const [marker, previous, written] of [
			['unfinished', 'success', ['error']],
			['unfinished', 'failure', []],
			['finished', 'success', []],
		] as const)
			test.effect(
				`a complete reply-only run's failed write over an ${marker} summary over a ${previous} writes ${written.length === 0 ? 'no status' : written[0]}`,
				() =>
					Effect.gen(function* () {
						const fixture = publishEventFixture()
						fixture.fake.reviews.push(
							appReview(
								fixture,
								marker === 'unfinished'
									? { finished: false, failed: true }
									: { finished: true }
							)
						)
						seedStatus(
							fixture,
							previous === 'failure'
								? toCommitStatus('needs owner', 0, true)
								: toCommitStatus('ready', 0, true)
						)
						fixture.fake.failures.review.push(forbidden('createReview'))
						fixture.fake.failures.updateReview.push(forbidden('updateReview'))
						expect(
							yield* publishReplies(fixture).pipe(Effect.flip)
						).toBeInstanceOf(GitHubApiError)
						// The failed write leaves the marker as it was, so its hold still keeps a `success` off.
						expect(fixture.status.statuses.map(status => status.state)).toEqual(
							written
						)
					})
			)
	}
)
