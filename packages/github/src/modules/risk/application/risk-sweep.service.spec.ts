import { layer } from '@effect/vitest'
import { toAnswerDigest } from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import type {
	WorkflowJob,
	WorkflowRun,
} from '../../../platform/github-risk.schema'
import { GitHubApiError } from '../../../platform/github.errors'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { githubRiskFake } from '../../../shared/mocks/github-risk-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	summaryReview,
	threadReply,
} from '../../../shared/mocks/publish-test.helper'
import { pendingReviewThread } from '../../../shared/mocks/thread-reply-test.helper'
import { ReplyNamingServiceLive } from '../../publish/application/reply-naming.service'
import { SummaryReviewService } from '../../publish/application/summary-review.service'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import { toAnswerEntry } from '../domain/answer.helper'
import {
	HEAD_DISPATCH_AT,
	HEAD_DISPATCH_VERSION,
	IN_FLIGHT_STATUSES,
	PUSH_EVENT,
	RATING_EVENTS,
	RISK_JOB_NAMES,
} from '../domain/risk.constants'
import type { AppRiskStatus } from '../domain/risk.types'
import {
	type DispatchKey,
	toDecideJobName,
} from '../domain/sweep-dispatch.helper'
import { RiskReadService } from './risk-read.service'
import {
	RiskSweepService,
	RiskSweepServiceLive,
	type SweepPullInput,
} from './risk-sweep.service'

const SINCE = '2025-12-01T00:00:00Z'
const OLD = '2025-12-15T00:00:00Z'
const TIME = '2026-01-01T12:00:00Z'
const LATER = '2026-01-02T12:00:00Z'
const NOW = '2026-02-01T00:00:00Z'
const FUTURE = '2030-01-01T00:00:00Z'
const INPUT = {
	pullNumber: 17,
	head: 'b'.repeat(40),
	since: SINCE,
	repositoryId: 1,
	checks: { review: true, converse: true },
	maxRuns: 5,
	workflow: 'review.yml',
	defaultBranch: 'main',
} as const satisfies SweepPullInput
const STATUS = {
	id: 1,
	sha: INPUT.head,
	state: 'success',
	description: {
		pr: 17,
		level: 'low',
		floor: false,
		base: 'a'.repeat(40),
		rules: 'c'.repeat(12),
		nonce: 'd'.repeat(16),
	},
	current: true,
} as const satisfies AppRiskStatus
const WRITER = { __typename: 'User', login: 'writer' } as const
/** The key of the converse the sweep dispatches for reply 42 as `addReply` posts it. */
const REPLY_KEY = {
	kind: 'converse',
	id: 42,
	digest: toAnswerDigest('confirmed'),
	at: TIME,
	head: INPUT.head,
} as const satisfies DispatchKey
/** The key of a review dispatch for an unrated head. */
const HEAD_KEY = {
	kind: 'review',
	id: 17,
	digest: HEAD_DISPATCH_VERSION,
	at: HEAD_DISPATCH_AT,
	head: INPUT.head,
} as const satisfies DispatchKey

/** A named default-branch workflow run, with overridable event provenance. */
function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
	return {
		id: 7,
		display_title: 'mng-review-risk-17',
		status: 'completed',
		conclusion: 'success',
		created_at: LATER,
		event: 'workflow_dispatch',
		path: '.github/workflows/review.yml',
		head_branch: 'main',
		head_repository: { id: 1 },
		...overrides,
	}
}

/** A job of a run by name; `null` is still running. */
function job(name: string, conclusion: string | null): WorkflowJob {
	return {
		name,
		status: conclusion === null ? 'in_progress' : 'completed',
		conclusion,
	}
}

/** A run and its jobs, added to the fake's runs list. */
function addRun(
	fixture: ReturnType<typeof setup>,
	run: WorkflowRun,
	jobs: readonly WorkflowJob[]
) {
	fixture.risk.runs.push(run)
	fixture.risk.jobs.set(run.id, [...jobs])
}

/** The real sweep and naming rule, with in-memory GitHub and explicit risk reads. */
function setup(rated = true) {
	const api = githubApiFake(APP_IDENTITY)
	const risk = githubRiskFake()
	const statuses: AppRiskStatus[] = rated ? [STATUS] : []
	const reads = Layer.succeed(RiskReadService, {
		readHeadStatuses: () => Effect.succeed(statuses),
		readHeld: () => Effect.die('unused held read'),
		readMarker: () => Effect.die('unused marker read'),
		readHistory: () => Effect.die('unused history read'),
		readThreadBugs: () => Effect.die('unused thread raise'),
		readMergeBase: () => Effect.die('unused merge base read'),
		readFloors: () => Effect.die('unused floor read'),
		readTree: () => Effect.die('unused tree read'),
	})
	const summaries = Layer.succeed(SummaryReviewService, {
		readWaiting: () => Effect.succeed([]),
		readPrior: () => Effect.die('unused summary read'),
		write: () => Effect.die('unexpected summary write'),
		publishStatus: () => Effect.die('unexpected summary status'),
		reserveManualRun: () => Effect.die('unexpected reservation'),
	})
	const dependencies = Layer.mergeAll(
		api.api,
		risk.layer,
		reads,
		summaries,
		ReplyNamingServiceLive.pipe(Layer.provide(api.api))
	)
	return {
		api,
		risk,
		statuses,
		live: RiskSweepServiceLive.pipe(Layer.provide(dependencies)),
	}
}

/** Sweeps the pull request once over the fixture. */
function sweep(
	fixture: ReturnType<typeof setup>,
	input: SweepPullInput = INPUT
) {
	return RiskSweepService.use(service => service.sweepPull(input)).pipe(
		Effect.provide(fixture.live)
	)
}

/** A thread reply whose current version has never been named by the app. */
function addReply(
	fixture: ReturnType<typeof setup>,
	resolved = false,
	replyTime = TIME
) {
	const reply = threadReply({
		databaseId: 42,
		body: 'confirmed',
		createdAt: replyTime,
		author: WRITER,
	})
	const answer = threadReply({
		databaseId: 50,
		createdAt: LATER,
		author: { __typename: 'Bot', login: APP_IDENTITY.login },
	})
	const raw = pendingReviewThread({
		isResolved: resolved,
		latest: { nodes: resolved ? [reply, answer] : [reply] },
	})
	const root = raw.comments.nodes.map(comment => ({
		...comment,
		author: { __typename: 'Bot', login: APP_IDENTITY.login },
	}))
	fixture.api.threads.push({
		...raw,
		comments: { ...raw.comments, nodes: root },
	})
	fixture.api.threadComments.set(raw.id, [
		...root,
		reply,
		...(resolved ? [answer] : []),
	])
}

/** A writer's thread comment created at `TIME`, edited at `lastEditedAt` when given. */
function writerComment(databaseId: number, lastEditedAt?: string) {
	return threadReply({
		databaseId,
		author: WRITER,
		body: `comment ${databaseId}`,
		createdAt: TIME,
		...(lastEditedAt ? { lastEditedAt } : {}),
	})
}

/** A review body a writer submitted at `TIME`. */
function addReviewBody(fixture: ReturnType<typeof setup>) {
	fixture.api.reviews.push(
		summaryReview(undefined, {
			databaseId: 60,
			body: 'Review context',
			author: WRITER,
			createdAt: TIME,
			submittedAt: TIME,
		})
	)
}

layer(APP_MODE_OWNED)('RiskSweepService', test => {
	test.effect(
		'an unrated head dispatches exactly one review keyed by the pull request',
		() =>
			Effect.gen(function* () {
				const fixture = setup(false)
				expect(yield* sweep(fixture)).toMatchObject({
					reason: 'no-status',
					verdict: 'dispatch',
				})
				expect(fixture.risk.dispatches).toEqual([
					{
						workflow: 'review.yml',
						ref: 'main',
						inputs: {
							source: 'sweep',
							number: '17',
							kind: 'review',
							comment: '17',
							version: HEAD_DISPATCH_VERSION,
							edited: HEAD_DISPATCH_AT,
							head: INPUT.head,
						},
					},
				])
			})
	)
	for (const scenario of ['checks', 'in flight', 'limit'] as const)
		test.effect(`an unrated head writes nothing at ${scenario}`, () =>
			Effect.gen(function* () {
				const fixture = setup(false)
				if (scenario === 'in flight')
					fixture.risk.runs.push(
						workflowRun({ status: 'queued', conclusion: null })
					)
				// The head dispatch's own key counts toward the run limit.
				if (scenario === 'limit')
					addRun(fixture, workflowRun(), [
						job(toDecideJobName(HEAD_KEY), 'success'),
						job(RISK_JOB_NAMES.RATING, 'failure'),
					])
				expect(
					yield* sweep(fixture, {
						...INPUT,
						checks: {
							review: scenario !== 'checks',
							converse: true,
						},
						maxRuns: scenario === 'limit' ? 1 : 5,
					})
				).toMatchObject({
					verdict:
						scenario === 'checks'
							? 'checks-failed'
							: scenario === 'limit'
								? 'run-limit'
								: 'in-flight',
				})
				expect(fixture.risk.dispatches).toEqual([])
			})
		)
	for (const conclusion of ['cancelled', 'failure', 'skipped', 'success', null])
		test.effect(
			`an unanswered reply obeys the repeat rule after a converse job ${conclusion}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					addReply(fixture)
					// The first job after decide is not the group job; the converse job is.
					addRun(
						fixture,
						workflowRun({
							status: conclusion === null ? 'in_progress' : 'completed',
							conclusion,
						}),
						[
							job(toDecideJobName(REPLY_KEY), 'success'),
							job('unlabel', 'success'),
							job(RISK_JOB_NAMES.RATING, 'skipped'),
							job(RISK_JOB_NAMES.CONVERSE, conclusion),
						]
					)
					const expected =
						conclusion === 'failure' || conclusion === 'skipped'
							? 'blocked'
							: conclusion === null
								? 'in-flight'
								: 'dispatch'
					expect(yield* sweep(fixture)).toMatchObject({
						reason: 'reply-unanswered',
						verdict: expected,
					})
					expect(fixture.risk.dispatches).toHaveLength(
						expected === 'dispatch' ? 1 : 0
					)
				})
		)
	for (const change of [
		{ digest: toAnswerDigest('old reply') },
		{ at: '2025-12-31T12:00:00Z' },
	])
		test.effect(
			`an edit makes a failed reply dispatch eligible again: ${Object.keys(change).join(',')}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					addReply(fixture)
					addRun(fixture, workflowRun({ conclusion: 'failure' }), [
						job(toDecideJobName({ ...REPLY_KEY, ...change }), 'success'),
						job(RISK_JOB_NAMES.CONVERSE, 'failure'),
					])
					expect(yield* sweep(fixture)).toMatchObject({ verdict: 'dispatch' })
				})
		)
	for (const resolved of [false, true])
		test.effect(
			`${resolved ? 'resolved' : 'open'} thread dispatches a converse naming the reply version`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					addReply(fixture, resolved)
					yield* sweep(fixture)
					expect(fixture.risk.dispatches).toEqual([
						{
							workflow: 'review.yml',
							ref: 'main',
							inputs: {
								source: 'sweep',
								number: '17',
								kind: 'converse',
								comment: '42',
								version: REPLY_KEY.digest,
								edited: TIME,
								head: INPUT.head,
							},
						},
					])
				})
		)
	test.effect('a reply after a resolving answer does not hold', () =>
		Effect.gen(function* () {
			const fixture = setup()
			addReply(fixture, true, '2026-01-03T12:00:00Z')
			expect(yield* sweep(fixture)).toMatchObject({ verdict: 'none' })
			expect(fixture.risk.dispatches).toEqual([])
		})
	)
	for (const author of [
		APP_IDENTITY.login,
		GITHUB_ACTIONS_IDENTITY.login,
	] as const)
		test.effect(
			`a converse answer by ${author} ${author === APP_IDENTITY.login ? 'lifts' : 'keeps'} the unanswered reply hold`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					addReply(fixture)
					const entry = toAnswerEntry(8, 'converse', [
						{ id: 42, at: TIME, body: 'confirmed' },
					])
					fixture.api.threadComments.get('thread')?.push(
						threadReply({
							databaseId: 50,
							author: { __typename: 'Bot', login: author },
							createdAt: TIME,
							body: toMarkerComment('reply', {
								v: 1,
								action: 'seen',
								commit: 'head',
								reply: 42,
								answers: entry ? [entry] : [],
							}),
						})
					)
					expect(yield* sweep(fixture)).toMatchObject(
						author === APP_IDENTITY.login
							? { verdict: 'none' }
							: { reason: 'reply-unanswered' }
					)
				})
		)
	for (const source of ['review body', 'writer thread'] as const)
		for (const conclusion of [
			'success',
			'failure',
			'cancelled',
			'skipped',
			null,
		])
			test.effect(
				`${source} requires a later review whose rating job ended success or failure, saw ${conclusion}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						if (source === 'review body') addReviewBody(fixture)
						else {
							const thread = pendingReviewThread({
								isResolved: true,
								latest: { nodes: [] },
							})
							fixture.api.threads.push({
								...thread,
								comments: {
									...thread.comments,
									nodes: [
										threadReply({
											databaseId: 60,
											author: WRITER,
											body: 'Review context',
											createdAt: TIME,
										}),
									],
								},
							})
						}
						addRun(
							fixture,
							workflowRun({
								event: 'issue_comment',
								status: conclusion === null ? 'in_progress' : 'completed',
								conclusion,
							}),
							[job('decide', 'success'), job(RISK_JOB_NAMES.RATING, conclusion)]
						)
						const rated = conclusion === 'success' || conclusion === 'failure'
						expect(yield* sweep(fixture)).toMatchObject({
							verdict: rated
								? 'none'
								: conclusion === null
									? 'in-flight'
									: 'dispatch',
						})
						expect(fixture.risk.dispatches).toHaveLength(
							rated || conclusion === null ? 0 : 1
						)
					})
			)
	test.effect(
		'a converse run that ended success is not a rating for the review hold',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				addReviewBody(fixture)
				addRun(fixture, workflowRun(), [
					job(toDecideJobName(REPLY_KEY), 'success'),
					job(RISK_JOB_NAMES.RATING, 'success'),
					job(RISK_JOB_NAMES.CONVERSE, 'success'),
				])
				expect(yield* sweep(fixture)).toMatchObject({
					reason: 'review-unrated',
					verdict: 'dispatch',
				})
			})
	)
	test.effect(
		'a review body dispatch carries the review id, its latest time and digest',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				addReviewBody(fixture)
				yield* sweep(fixture)
				expect(fixture.risk.dispatches.map(input => input.inputs)).toEqual([
					{
						source: 'sweep',
						number: '17',
						kind: 'review',
						comment: '60',
						version: toAnswerDigest('Review context'),
						edited: TIME,
						head: INPUT.head,
					},
				])
			})
	)
	test.effect(
		'a writer thread dispatch carries the comment that holds it: the latest one',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const first = threadReply({
					databaseId: 60,
					author: WRITER,
					body: 'Review context',
					createdAt: TIME,
				})
				const later = threadReply({
					databaseId: 61,
					author: WRITER,
					body: 'One more thing',
					createdAt: TIME,
					lastEditedAt: LATER,
				})
				const thread = pendingReviewThread({
					isResolved: true,
					latest: { nodes: [first, later] },
				})
				fixture.api.threads.push({
					...thread,
					comments: { ...thread.comments, nodes: [first] },
				})
				yield* sweep(fixture)
				expect(fixture.risk.dispatches.map(input => input.inputs)).toEqual([
					expect.objectContaining({
						comment: '61',
						version: toAnswerDigest('One more thing'),
						edited: LATER,
					}),
				])
			})
	)
	test.effect(
		'a later full push rating also satisfies the human review hold',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				addReviewBody(fixture)
				addRun(
					fixture,
					workflowRun({
						event: PUSH_EVENT,
						display_title: 'Review change',
						head_branch: 'feature',
						pull_requests: [{ number: 17, base: { ref: 'main' } }],
					}),
					[job(`review / ${RISK_JOB_NAMES.RATING}`, 'success')]
				)
				expect(yield* sweep(fixture)).toMatchObject({ verdict: 'none' })
				expect(fixture.risk.dispatches).toEqual([])
			})
	)
	test.effect(
		'a role read failure fails the pass instead of dropping the reply hold',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				addReply(fixture)
				fixture.api.failures.getCollaboratorRole.push(
					new GitHubApiError({
						operation: 'getCollaboratorRole',
						reason: 'role unavailable',
						status: 403,
					})
				)
				const outcome = yield* sweep(fixture).pipe(Effect.result)
				expect(outcome._tag).toBe('Failure')
				expect(fixture.risk.dispatches).toEqual([])
			})
	)
	test.effect(
		'reads the runs in flight from the pull request on, the review workflow runs from the holding comment on and the head dispatches from its arrival',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				addReply(fixture)
				yield* sweep(fixture)
				expect(fixture.risk.queries).toEqual([
					...IN_FLIGHT_STATUSES.map(status => ({ status, since: SINCE })),
					...RATING_EVENTS.map(event => ({
						workflow: 'review.yml',
						event,
						branch: 'main',
						since: TIME,
					})),
					{ workflow: 'review.yml', event: PUSH_EVENT, since: TIME },
					{
						workflow: 'review.yml',
						event: 'workflow_dispatch',
						branch: 'main',
						since: SINCE,
					},
				])
			})
	)
	test.effect(
		'a failed run listing fails the pass and dispatches nothing',
		() =>
			Effect.gen(function* () {
				const fixture = setup(false)
				fixture.risk.runFailures.push(
					new GitHubApiError({
						operation: 'listRuns',
						reason: 'more than 2000 entries',
					})
				)
				const outcome = yield* sweep(fixture).pipe(Effect.result)
				expect(outcome._tag).toBe('Failure')
				expect(fixture.risk.dispatches).toEqual([])
			})
	)
	for (const conclusion of ['success', 'skipped'] as const)
		for (const runAfter of [false, true])
			test.effect(
				`an app comment predating the reply answers it only through a later run whose converse job did not skip: after=${runAfter} ${conclusion}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						addReply(fixture)
						const entry = toAnswerEntry(7, 'converse', [
							{ id: 42, at: TIME, body: 'confirmed' },
						])
						fixture.api.threadComments.get('thread')?.push(
							threadReply({
								databaseId: 50,
								author: { __typename: 'Bot', login: APP_IDENTITY.login },
								createdAt: '2025-12-31T12:00:00Z',
								lastEditedAt: LATER,
								body: toMarkerComment('reply', {
									v: 1,
									action: 'seen',
									commit: 'head',
									reply: 42,
									answers: entry ? [entry] : [],
								}),
							})
						)
						addRun(
							fixture,
							workflowRun({
								created_at: runAfter ? LATER : '2025-12-31T12:00:00Z',
							}),
							[job(RISK_JOB_NAMES.CONVERSE, conclusion)]
						)
						expect(yield* sweep(fixture)).toMatchObject({
							verdict:
								runAfter && conclusion === 'success' ? 'none' : 'dispatch',
						})
					})
			)
	for (const scenario of ['other workflow', 'other repository'] as const)
		test.effect(
			`a run with a matching title from the ${scenario} cannot clear the review hold`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					addReviewBody(fixture)
					addRun(
						fixture,
						workflowRun({
							event: 'issue_comment',
							...(scenario === 'other workflow'
								? { path: '.github/workflows/unrelated.yml' }
								: { head_repository: { id: 2 } }),
						}),
						[job(RISK_JOB_NAMES.RATING, 'success')]
					)
					expect(yield* sweep(fixture)).toMatchObject({
						verdict: 'dispatch',
						reason: 'review-unrated',
					})
				})
		)
	test.effect(
		'an unrated head counts its dispatch whose run path carries the ref',
		() =>
			Effect.gen(function* () {
				const fixture = setup(false)
				addRun(
					fixture,
					workflowRun({ path: '.github/workflows/review.yml@main' }),
					[
						job(toDecideJobName(HEAD_KEY), 'success'),
						job(RISK_JOB_NAMES.RATING, 'failure'),
					]
				)
				expect(yield* sweep(fixture, { ...INPUT, maxRuns: 1 })).toMatchObject({
					verdict: 'run-limit',
				})
				expect(fixture.risk.dispatches).toEqual([])
			})
	)
	test.effect(
		'a rating run whose path carries the ref clears the review hold',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				addReviewBody(fixture)
				addRun(
					fixture,
					workflowRun({
						event: 'issue_comment',
						path: '.github/workflows/review.yml@main',
					}),
					[job(RISK_JOB_NAMES.RATING, 'success')]
				)
				expect(yield* sweep(fixture)).toMatchObject({ verdict: 'none' })
			})
	)
	test.effect(
		'a blocked reply does not keep a review body from its one dispatch',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				addReply(fixture)
				addReviewBody(fixture)
				addRun(fixture, workflowRun(), [
					job(toDecideJobName(REPLY_KEY), 'success'),
					job(RISK_JOB_NAMES.CONVERSE, 'failure'),
				])
				expect(yield* sweep(fixture)).toMatchObject({
					reason: 'review-unrated',
					verdict: 'dispatch',
				})
				expect(fixture.risk.dispatches.map(input => input.inputs)).toEqual([
					expect.objectContaining({ kind: 'review', comment: '60' }),
				])
			})
	)
	test.effect(
		'a blocked reply does not keep a later reply in another thread from dispatching',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				addReply(fixture)
				const [thread] = fixture.api.threads
				const comments = fixture.api.threadComments.get('thread') ?? []
				const reply = threadReply({
					databaseId: 43,
					body: 'also confirmed',
					createdAt: TIME,
					author: WRITER,
				})
				if (thread)
					fixture.api.threads.push({
						...thread,
						id: 'second',
						latest: { nodes: [reply] },
					})
				fixture.api.threadComments.set('second', [
					...comments.filter(comment => comment.databaseId !== 42),
					reply,
				])
				addRun(fixture, workflowRun(), [
					job(toDecideJobName(REPLY_KEY), 'success'),
					job(RISK_JOB_NAMES.CONVERSE, 'failure'),
				])
				expect(yield* sweep(fixture)).toMatchObject({
					reason: 'reply-unanswered',
					verdict: 'dispatch',
				})
				expect(fixture.risk.dispatches.map(input => input.inputs)).toEqual([
					expect.objectContaining({ kind: 'converse', comment: '43' }),
				])
			})
	)
	test.effect(
		'a writer thread edited between its first and latest comments reads the whole thread',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const latest = Array.from({ length: 10 }, (_, index) =>
					writerComment(70 + index)
				)
				const edited = writerComment(62, '2026-01-03T12:00:00Z')
				const thread = pendingReviewThread({
					id: 'long',
					isResolved: true,
					comments: { totalCount: 13, nodes: [writerComment(60)] },
					latest: { nodes: latest },
				})
				fixture.api.threads.push(thread)
				fixture.api.threadComments.set('long', [
					writerComment(60),
					writerComment(61),
					edited,
					...latest,
				])
				addRun(fixture, workflowRun({ event: 'issue_comment' }), [
					job(RISK_JOB_NAMES.RATING, 'success'),
				])
				expect(yield* sweep(fixture)).toMatchObject({
					reason: 'review-unrated',
					verdict: 'dispatch',
				})
				expect(fixture.risk.dispatches.map(input => input.inputs)).toEqual([
					expect.objectContaining({
						comment: '62',
						edited: '2026-01-03T12:00:00Z',
					}),
				])
			})
	)
})

/** A converse run for `REPLY_KEY` whose decide job ended `decide`, its group job skipped. */
function addConverseRun(
	fixture: ReturnType<typeof setup>,
	id: number,
	decide: string
) {
	addRun(fixture, workflowRun({ id, conclusion: 'failure' }), [
		job(toDecideJobName(REPLY_KEY), decide),
		job(RISK_JOB_NAMES.CONVERSE, 'skipped'),
	])
}

/** The `since` of every runs query that lists the review workflow's started runs. */
function getStartedSince(fixture: ReturnType<typeof setup>) {
	return fixture.risk.queries
		.filter(query => query.workflow !== undefined)
		.map(query => query.since)
}

layer(APP_MODE_OWNED)('RiskSweepService gates, repeats and bounds', test => {
	for (const scenario of ['unrated head', 'review body', 'reply'] as const)
		test.effect(
			`a review dispatch meets the review gate, a converse only its own checks: ${scenario}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup(scenario !== 'unrated head')
					if (scenario === 'review body') addReviewBody(fixture)
					if (scenario === 'reply') addReply(fixture)
					expect(
						yield* sweep(fixture, {
							...INPUT,
							checks: { review: false, converse: true },
						})
					).toMatchObject({
						verdict: scenario === 'reply' ? 'dispatch' : 'checks-failed',
					})
					expect(fixture.risk.dispatches).toHaveLength(
						scenario === 'reply' ? 1 : 0
					)
				})
		)
	for (const failures of [1, 2])
		test.effect(
			`a converse whose decide job failed ${failures} time(s) ${failures === 1 ? 'is dispatched once more' : 'stays blocked'}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					addReply(fixture)
					for (const index of Array.from({ length: failures }, (_, at) => at))
						addConverseRun(fixture, 7 + index, 'failure')
					expect(yield* sweep(fixture)).toMatchObject({
						reason: 'reply-unanswered',
						verdict: failures === 1 ? 'dispatch' : 'blocked',
					})
				})
		)
	test.effect(
		'a converse the decide job skipped on purpose stays blocked',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				addReply(fixture)
				addConverseRun(fixture, 7, 'success')
				expect(yield* sweep(fixture)).toMatchObject({ verdict: 'blocked' })
			})
	)
	test.effect(
		'lists the started runs from the oldest holding comment, and the head dispatches from its arrival',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				addReply(fixture, false, LATER)
				addReviewBody(fixture)
				yield* sweep(fixture)
				expect(getStartedSince(fixture).length).toBeGreaterThan(0)
				expect(new Set(getStartedSince(fixture))).toEqual(
					new Set([TIME, SINCE])
				)
				expect(
					fixture.risk.queries
						.filter(query => query.workflow && query.since === SINCE)
						.map(query => query.event)
				).toEqual(['workflow_dispatch'])
			})
	)
	test.effect(
		'an old non-writer review and an old rated writer review do not pin the runs bound',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.api.reviews.push(
					summaryReview(undefined, {
						databaseId: 59,
						body: 'Drive-by context',
						author: { __typename: 'User', login: 'reader' },
						createdAt: OLD,
						submittedAt: OLD,
					})
				)
				addReviewBody(fixture)
				// The reader is not a collaborator; the writer keeps the fake's admin role.
				fixture.api.failures.getCollaboratorRole.push(
					new GitHubApiError({
						operation: 'getCollaboratorRole',
						status: 404,
						reason: 'not a collaborator',
					})
				)
				addRun(fixture, workflowRun({ event: 'issue_comment' }), [
					job(RISK_JOB_NAMES.RATING, 'success'),
				])
				expect(yield* sweep(fixture)).toMatchObject({ verdict: 'none' })
				expect(getStartedSince(fixture).length).toBeGreaterThan(0)
				expect(new Set(getStartedSince(fixture))).toEqual(new Set([TIME]))
			})
	)
	test.effect(
		'a new holding comment does not start a fresh run budget on the same head',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse(NOW))
				const fixture = setup()
				addReply(fixture, false, LATER)
				for (const id of [1, 2])
					addRun(
						fixture,
						workflowRun({ id, created_at: TIME, conclusion: 'success' }),
						[
							job(
								toDecideJobName({ ...REPLY_KEY, id: 30 + id, at: OLD }),
								'success'
							),
							job(RISK_JOB_NAMES.CONVERSE, 'success'),
						]
					)
				expect(yield* sweep(fixture, { ...INPUT, maxRuns: 2 })).toMatchObject({
					reason: 'reply-unanswered',
					verdict: 'run-limit',
				})
				expect(fixture.risk.dispatches).toEqual([])
			})
	)
	test.effect('lists no run when no comment holds the pull request', () =>
		Effect.gen(function* () {
			const fixture = setup()
			expect(yield* sweep(fixture)).toMatchObject({ verdict: 'none' })
			expect(fixture.risk.queries).toEqual([])
		})
	)
	for (const arrival of [
		'force push',
		'commit',
		'future commit',
		'unknown',
	] as const)
		test.effect(
			`an unrated head lists its runs from the head's bounded arrival: ${arrival}`,
			() =>
				Effect.gen(function* () {
					yield* TestClock.setTime(Date.parse(NOW))
					const fixture = setup(false)
					if (arrival === 'force push')
						fixture.risk.timeline.push({
							__typename: 'HeadRefForcePushedEvent',
							createdAt: LATER,
							beforeCommit: { oid: 'c'.repeat(40) },
							afterCommit: { oid: INPUT.head },
						})
					if (arrival === 'commit' || arrival === 'future commit')
						fixture.risk.timeline.push({
							__typename: 'PullRequestCommit',
							commit: {
								oid: INPUT.head,
								committedDate: arrival === 'commit' ? TIME : FUTURE,
							},
						})
					yield* sweep(fixture)
					expect(new Set(getStartedSince(fixture))).toEqual(
						new Set([arrival === 'force push' ? LATER : SINCE])
					)
				})
		)
	test.effect(
		'a future committer date does not hide earlier dispatches of the head from the run limit',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse(NOW))
				const fixture = setup(false)
				fixture.risk.timeline.push({
					__typename: 'PullRequestCommit',
					commit: { oid: INPUT.head, committedDate: FUTURE },
				})
				for (const id of [1, 2])
					addRun(
						fixture,
						workflowRun({ id, created_at: TIME, conclusion: 'success' }),
						[
							job(toDecideJobName(HEAD_KEY), 'success'),
							job(RISK_JOB_NAMES.RATING, 'success'),
						]
					)
				expect(yield* sweep(fixture, { ...INPUT, maxRuns: 2 })).toMatchObject({
					verdict: 'run-limit',
				})
				expect(fixture.risk.dispatches).toEqual([])
			})
	)
	for (const scenario of ['unrated head', 'reply'] as const)
		test.effect(
			`without a dispatch workflow a needed dispatch reports no-workflow: ${scenario}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup(scenario !== 'unrated head')
					if (scenario === 'reply') addReply(fixture)
					const { workflow: _workflow, ...input } = INPUT
					expect(yield* sweep(fixture, input)).toMatchObject({
						verdict: 'no-workflow',
					})
					expect(fixture.risk.dispatches).toEqual([])
					expect(getStartedSince(fixture)).toEqual([])
				})
		)
})
