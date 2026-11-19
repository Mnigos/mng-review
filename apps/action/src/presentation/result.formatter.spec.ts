import { REDACTED, toReviewJson } from '@mng-review/engine'
import { Schema } from 'effect'
import type {
	PullRequestEvent,
	ShadowOutcome,
} from '../application/shadow-run.types'
import { BASE_SHA, HEAD_SHA } from '../shared/mocks/pull-request-event.helper'
import { reviewReport } from '../shared/mocks/review-report.helper'
import {
	formatResult,
	RESULT_VERSION,
	type ResultContext,
} from './result.formatter'
import { formatSummary, toVerdictLine } from './summary.formatter'

const decodeJson = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Unknown)
)
const EVENT = {
	number: 17,
	baseSha: BASE_SHA,
	headSha: HEAD_SHA,
	pr: {
		target: 'main',
		author: 'contributor',
		labels: ['storage', 'review'],
		draft: true,
		fork: false,
		trigger: 'auto',
		title: 'PR title must stay private',
		body: 'PR body must stay private',
	},
} as const satisfies PullRequestEvent
const CONTEXT = {
	engineCommit: '1234567890abcdef',
	repository: 'example/project',
	eventName: 'pull_request_target',
	runId: '12345678901234567890',
	runAttempt: '2',
	wallMillis: 4321,
	masked: [],
} as const satisfies ResultContext
const UNREVIEWED = [
	{ status: 'skipped', reason: 'not a pull request event' },
	{ status: 'skipped', reason: 'draft pull request', event: EVENT },
	{ status: 'offline', reason: 'endpoint unavailable', event: EVENT },
	{
		status: 'invalid-config',
		reason: 'unknown setting',
		source: '.mng/review.yml',
	},
	{
		status: 'invalid-config',
		reason: 'invalid base rules',
		source: '.mng/review.yml',
		event: EVENT,
	},
	{ status: 'failed', reason: 'missing base commit', event: EVENT },
] as const satisfies readonly ShadowOutcome[]

describe('formatResult', () => {
	test('writes the complete versioned reviewed document with the CLI review value', () => {
		const report = reviewReport()
		expect(
			decodeJson(
				formatResult({ status: 'reviewed', event: EVENT, report }, CONTEXT)
			)
		).toEqual({
			version: RESULT_VERSION,
			status: 'reviewed',
			engineCommit: CONTEXT.engineCommit,
			run: {
				repository: CONTEXT.repository,
				eventName: CONTEXT.eventName,
				runId: CONTEXT.runId,
				runAttempt: CONTEXT.runAttempt,
			},
			pullRequest: {
				number: EVENT.number,
				baseSha: BASE_SHA,
				headSha: HEAD_SHA,
				target: EVENT.pr.target,
				author: EVENT.pr.author,
				labels: EVENT.pr.labels,
				draft: EVENT.pr.draft,
			},
			wallMillis: CONTEXT.wallMillis,
			verdict: toVerdictLine(report),
			tokens: report.tokens,
			reason: null,
			source: null,
			review: toReviewJson(report),
		})
	})

	for (const outcome of UNREVIEWED)
		test(`serializes ${outcome.status}: ${outcome.reason} without a review or token usage`, () => {
			expect(decodeJson(formatResult(outcome, CONTEXT))).toMatchObject({
				status: outcome.status,
				pullRequest:
					'event' in outcome
						? {
								number: EVENT.number,
								baseSha: BASE_SHA,
								headSha: HEAD_SHA,
								target: EVENT.pr.target,
								author: EVENT.pr.author,
								labels: EVENT.pr.labels,
								draft: EVENT.pr.draft,
							}
						: null,
				wallMillis: CONTEXT.wallMillis,
				reason: outcome.reason,
				source: outcome.status === 'invalid-config' ? outcome.source : null,
				verdict: null,
				tokens: {},
				review: null,
			})
		})

	test('uses null for unknown engine and run identifiers and absent PR metadata', () => {
		expect(
			decodeJson(
				formatResult(
					{
						status: 'skipped',
						reason: 'fork pull request',
						event: {
							...EVENT,
							pr: { labels: [], draft: false, fork: true, trigger: 'auto' },
						},
					},
					{
						engineCommit: undefined,
						repository: undefined,
						eventName: 'pull_request',
						runId: undefined,
						runAttempt: undefined,
						wallMillis: 0,
						masked: [],
					}
				)
			)
		).toMatchObject({
			engineCommit: null,
			run: {
				repository: null,
				eventName: 'pull_request',
				runId: null,
				runAttempt: null,
			},
			pullRequest: { target: null, author: null, labels: [], draft: false },
			wallMillis: 0,
		})
	})

	test('uses null for an unset event name from runner defaults', () => {
		expect(
			decodeJson(
				formatResult(
					{ status: 'skipped', reason: 'not a pull request event' },
					{ ...CONTEXT, eventName: '' }
				)
			)
		).toMatchObject({
			run: { eventName: null },
		})
	})

	test('redacts repeated escaped values longest first in run, PR and nested review strings', () => {
		const url = 'http://inference.example.com:8080/v1'
		const key = 'fixture-"quoted"\\key\nnext-line'
		const sensitive = `${url} ${key} ${url}`
		const expected = `${REDACTED} ${REDACTED} ${REDACTED}`
		const fixture = reviewReport()
		const report = {
			...fixture,
			bugs: fixture.bugs.map(bug => ({ ...bug, trigger: sensitive })),
			nits: fixture.nits.map(nit => ({ ...nit, impact: sensitive })),
			rejected: fixture.rejected.map(finding => ({
				...finding,
				reason: sensitive,
			})),
			agents: fixture.agents.map(agent => ({ ...agent, error: sensitive })),
			endpointError: sensitive,
			incomplete: { reason: sensitive, unfinished: [sensitive] },
		}
		const before = structuredClone(report)
		const context = {
			...CONTEXT,
			engineCommit: sensitive,
			repository: sensitive,
			eventName: sensitive,
			runId: sensitive,
			runAttempt: sensitive,
			masked: [
				new URL(url).hostname,
				key,
				new URL(url).host,
				new URL(url).origin,
				url,
			],
		}
		const event = {
			...EVENT,
			baseSha: sensitive,
			headSha: sensitive,
			pr: {
				...EVENT.pr,
				target: sensitive,
				author: sensitive,
				labels: [sensitive],
			},
		}
		const text = formatResult({ status: 'reviewed', event, report }, context)
		expect(decodeJson(text)).toMatchObject({
			engineCommit: expected,
			run: {
				repository: expected,
				eventName: expected,
				runId: expected,
				runAttempt: expected,
			},
			pullRequest: {
				baseSha: expected,
				headSha: expected,
				target: expected,
				author: expected,
				labels: [expected],
			},
			review: {
				bugs: report.bugs.map(bug => ({ ...bug, trigger: expected })),
				nits: report.nits.map(nit => ({ ...nit, impact: expected })),
				rejected: report.rejected.map(finding => ({
					...finding,
					reason: expected,
				})),
				agents: report.agents.map(agent => ({ ...agent, error: expected })),
				endpointError: expected,
				incomplete: { reason: expected, unfinished: [expected] },
			},
		})
		for (const value of context.masked)
			expect(text).not.toContain(JSON.stringify(value).slice(1, -1))
		expect(text).not.toContain(EVENT.pr.title)
		expect(text).not.toContain(EVENT.pr.body)
		expect(report).toEqual(before)
		expect(context.masked).toEqual([
			new URL(url).hostname,
			key,
			new URL(url).host,
			new URL(url).origin,
			url,
		])
	})

	test('redacts only string values and preserves numbers, booleans, nulls and object keys', () => {
		const report = reviewReport()
		const json = decodeJson(
			formatResult(
				{ status: 'reviewed', event: EVENT, report },
				{
					...CONTEXT,
					wallMillis: RESULT_VERSION,
					runAttempt: String(RESULT_VERSION),
					masked: [
						'',
						String(RESULT_VERSION),
						'true',
						'version',
						'draft',
						'model-b',
					],
				}
			)
		)
		expect(json).toMatchObject({
			version: RESULT_VERSION,
			run: { runAttempt: REDACTED },
			pullRequest: { number: EVENT.number, draft: EVENT.pr.draft },
			wallMillis: RESULT_VERSION,
			reason: null,
			source: null,
			review: {
				blocking: report.blocking,
				agents: report.agents.map(agent => ({ ...agent, model: REDACTED })),
			},
		})
		expect(json).toHaveProperty('tokens', report.tokens)
		expect(json).toHaveProperty('review.tokens', report.tokens)
	})

	for (const outcome of UNREVIEWED)
		test(`redacts reason and source strings for ${outcome.status}: ${outcome.reason}`, () => {
			const sensitive = 'fixture-private-value'
			expect(
				decodeJson(
					formatResult(
						{
							...outcome,
							reason: sensitive,
							...(outcome.status === 'invalid-config'
								? { source: sensitive }
								: {}),
						},
						{ ...CONTEXT, masked: [sensitive] }
					)
				)
			).toMatchObject({
				reason: REDACTED,
				source: outcome.status === 'invalid-config' ? REDACTED : null,
			})
		})

	for (const kind of [
		'blocking',
		'ready',
		'incomplete',
		'endpoint-error',
	] as const)
		test(`uses the same ${kind} verdict as the job summary`, () => {
			const report = {
				...reviewReport(),
				...(kind === 'ready' ? { blocking: false, bugs: [] } : {}),
				...(kind === 'incomplete'
					? { incomplete: { reason: 'budget spent', unfinished: ['reviewer'] } }
					: {}),
				...(kind === 'endpoint-error'
					? { endpointError: 'no model available' }
					: {}),
			}
			const outcome = {
				status: 'reviewed',
				event: EVENT,
				report,
			} as const satisfies ShadowOutcome
			const verdict = toVerdictLine(report)
			expect(decodeJson(formatResult(outcome, CONTEXT))).toMatchObject({
				verdict,
			})
			expect(formatSummary(outcome, CONTEXT)).toContain(
				verdict.replaceAll('(', '\\(').replaceAll(')', '\\)')
			)
		})
})
