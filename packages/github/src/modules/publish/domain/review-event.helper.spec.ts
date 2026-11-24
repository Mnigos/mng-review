import { buildPlan, DEFAULT_PRESET } from '@mng-review/domain'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { planInput } from '../../../shared/mocks/domain-test.helper'
import {
	agentReport,
	APP_IDENTITY,
	botThread,
	COVERED_REVIEW,
	report,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { getCoverageGap } from './coverage-gap.helper'
import {
	getApproval,
	getReviewDecision,
	toDecidedSummary,
	type ReviewDecision,
	type ReviewEventInput,
} from './review-event.helper'

interface DecisionCase {
	readonly name: string
	readonly input: ReviewEventInput
	readonly expected: ReviewDecision
}

const REVIEWED = {
	kind: 'review',
	verdict: 'ready',
	onHead: true,
	openBugs: 0,
	full: true,
	failed: false,
	gap: undefined,
	approval: 'allowed',
	authored: false,
	changesRequested: false,
} as const satisfies ReviewEventInput
const REPLIED = {
	kind: 'reply',
	verdict: 'ready',
	openBugs: 0,
	current: true,
	onHead: true,
	failed: false,
	authored: false,
	changesRequested: false,
} as const satisfies ReviewEventInput
const FINDINGS_GAP = { kind: 'findings', findings: 1 } as const
const APPROVES = {
	event: 'APPROVE',
	keep: false,
	clears: true,
} as const satisfies ReviewDecision
const CLEARS = {
	event: 'COMMENT',
	keep: false,
	clears: true,
} as const satisfies ReviewDecision
const REQUESTS = {
	event: 'REQUEST_CHANGES',
	keep: false,
	clears: false,
} as const satisfies ReviewDecision
const KEEPS_COMMENT = {
	event: 'COMMENT',
	keep: true,
	clears: false,
} as const satisfies ReviewDecision
const KEEPS_REQUEST = {
	event: 'REQUEST_CHANGES',
	keep: true,
	clears: false,
} as const satisfies ReviewDecision

/** Every run kind with the evidence it carries, and what it does with the review state. */
const CASES = [
	{ name: 'covered push', input: REVIEWED, expected: APPROVES },
	{
		name: 'covered push in preview mode',
		input: { ...REVIEWED, approval: 'preview' },
		expected: CLEARS,
	},
	{
		name: 'finished push that did not cover the change',
		input: { ...REVIEWED, gap: FINDINGS_GAP },
		expected: CLEARS,
	},
	{
		name: 'push with a confirmed bug',
		input: { ...REVIEWED, verdict: 'needs fixes', gap: FINDINGS_GAP },
		expected: REQUESTS,
	},
	{
		name: 'push with a thread waiting for the owner',
		input: { ...REVIEWED, verdict: 'needs owner', gap: FINDINGS_GAP },
		expected: REQUESTS,
	},
	{
		name: 'unfinished push',
		input: { ...REVIEWED, verdict: 'incomplete', gap: FINDINGS_GAP },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'unfinished push under a change request',
		input: {
			...REVIEWED,
			verdict: 'incomplete',
			gap: FINDINGS_GAP,
			changesRequested: true,
		},
		expected: KEEPS_COMMENT,
	},
	{
		name: 'push whose head moved',
		input: { ...REVIEWED, onHead: false },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'push whose head moved under a change request',
		input: { ...REVIEWED, onHead: false, changesRequested: true },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'push whose head moved with a bug',
		input: { ...REVIEWED, onHead: false, verdict: 'needs fixes' },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'single-agent command that found nothing',
		input: { ...REVIEWED, full: false },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'single-agent command under a change request',
		input: { ...REVIEWED, full: false, changesRequested: true },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'single-agent command with a bug',
		input: { ...REVIEWED, full: false, verdict: 'needs fixes' },
		expected: REQUESTS,
	},
	{
		name: 'covered push on a pull request the bot opened',
		input: { ...REVIEWED, authored: true },
		expected: CLEARS,
	},
	{
		name: 'push with a bug on a pull request the bot opened',
		input: { ...REVIEWED, verdict: 'needs fixes', authored: true },
		expected: { ...REQUESTS, event: 'COMMENT' },
	},
	{
		name: 'reply-only run ready on the last full head',
		input: REPLIED,
		expected: CLEARS,
	},
	{
		name: 'reply-only run ready under a change request',
		input: { ...REPLIED, changesRequested: true },
		expected: CLEARS,
	},
	{
		name: 'reply-only run on another head',
		input: { ...REPLIED, onHead: false, changesRequested: true },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'reply-only run off the last full head with a bug under a change request',
		input: {
			...REPLIED,
			onHead: false,
			verdict: 'needs fixes',
			changesRequested: true,
		},
		expected: KEEPS_REQUEST,
	},
	{
		name: 'reply-only run with a bug left',
		input: { ...REPLIED, verdict: 'needs fixes', changesRequested: true },
		expected: REQUESTS,
	},
	{
		name: 'reply-only run waiting for the owner',
		input: { ...REPLIED, verdict: 'needs owner' },
		expected: REQUESTS,
	},
	{
		name: 'reply-only run incomplete',
		input: { ...REPLIED, verdict: 'incomplete' },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'offline run',
		input: { kind: 'offline', authored: false, changesRequested: false },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'offline run under a change request',
		input: { kind: 'offline', authored: false, changesRequested: true },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'finished ready push with a failed run',
		input: { ...REVIEWED, failed: true, gap: FINDINGS_GAP },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'finished ready push with a failed run under a change request',
		input: {
			...REVIEWED,
			failed: true,
			gap: FINDINGS_GAP,
			changesRequested: true,
		},
		expected: KEEPS_COMMENT,
	},
	{
		name: 'reply-only run ready after a full review with a failed run',
		input: { ...REPLIED, failed: true, changesRequested: true },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'reply-only run whose head moved, with a bug under a change request',
		input: {
			...REPLIED,
			current: false,
			onHead: false,
			verdict: 'needs fixes',
			changesRequested: true,
		},
		expected: KEEPS_COMMENT,
	},
	{
		name: 'reply-only run with a bug on a pull request the bot opened',
		input: { ...REPLIED, verdict: 'needs fixes', authored: true },
		expected: { ...REQUESTS, event: 'COMMENT' },
	},
	{
		name: 'offline run on a pull request the bot opened under a change request',
		input: { kind: 'offline', authored: true, changesRequested: true },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'covered run on a draft or closed pull request keeps the state',
		input: { ...REVIEWED, open: false },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'covered run on a draft or closed pull request under a change request keeps it',
		input: { ...REVIEWED, open: false, changesRequested: true },
		expected: KEEPS_COMMENT,
	},
	{
		name: 'uncovered run on a draft or closed pull request still comments and clears',
		input: { ...REVIEWED, open: false, gap: FINDINGS_GAP },
		expected: CLEARS,
	},
] as const satisfies readonly DecisionCase[]

test.each(CASES)('$name', scenario => {
	expect(getReviewDecision(scenario.input)).toStrictEqual(scenario.expected)
})

/** True when `getCoverageGap` finds nothing missing. */
function isCoveredBy(...input: Parameters<typeof getCoverageGap>): boolean {
	return getCoverageGap(...input) === undefined
}

describe('toDecidedSummary', () => {
	const rendered = { body: 'Summary', marker: SUMMARY_MARKER } as const
	const onHead = { current: 'head', authored: false } as const
	test('a review whose head is no longer the pull request head keeps the state', () => {
		expect(
			toDecidedSummary(
				{ ...rendered, evidence: COVERED_REVIEW },
				false,
				{ ...onHead, current: 'next-head' },
				'head'
			)
		).toStrictEqual({
			rendered: {
				...rendered,
				evidence: { ...COVERED_REVIEW, onHead: false, open: true },
			},
			decision: KEEPS_COMMENT,
		})
	})
	test('a head the latest read could not read keeps the state', () => {
		expect(
			toDecidedSummary(
				{ ...rendered, evidence: COVERED_REVIEW },
				false,
				{ ...onHead, current: undefined },
				'head'
			).decision
		).toStrictEqual(KEEPS_COMMENT)
	})
	test('a covered review the latest read finds a draft or closed keeps the state', () => {
		expect(
			toDecidedSummary(
				{ ...rendered, evidence: COVERED_REVIEW },
				false,
				{ ...onHead, open: false },
				'head'
			)
		).toStrictEqual({
			rendered: { ...rendered, evidence: { ...COVERED_REVIEW, open: false } },
			decision: KEEPS_COMMENT,
		})
	})
	test('a covered review on the latest head approves', () => {
		expect(
			toDecidedSummary(
				{ ...rendered, evidence: COVERED_REVIEW },
				false,
				onHead,
				'head'
			).decision
		).toStrictEqual(APPROVES)
	})
	test('a reply-only run on a head that moved since its own read keeps the state', () => {
		expect(
			toDecidedSummary(
				{ ...rendered, evidence: { ...REPLIED, verdict: 'needs fixes' } },
				true,
				{ ...onHead, current: 'next-head' },
				'head'
			).decision
		).toStrictEqual(KEEPS_COMMENT)
	})
	test('an offline render on a pull request the latest read shows the bot opened comments', () => {
		expect(
			toDecidedSummary(rendered, true, { ...onHead, authored: true }, 'head')
		).toStrictEqual({
			rendered: { ...rendered, evidence: { kind: 'offline', authored: true } },
			decision: KEEPS_COMMENT,
		})
	})
})

/** A report whose plan ran and reported the main reviewer and found nothing. */
function coveredReport() {
	const reviewed = report()
	return {
		...reviewed,
		bugs: [],
		agents: reviewed.planReport.plan.runs.map(run => ({
			...agentReport(),
			name: run.name,
		})),
	}
}

test('a report that ran and reported every planned finder covers the change', () => {
	expect(getCoverageGap(coveredReport(), [])).toBeUndefined()
})

test('a kept finding, an open nit thread or a failed unit leaves the change uncovered', () => {
	const covered = coveredReport()
	const [first] = covered.agents
	expect(getCoverageGap({ ...covered, nits: report().bugs }, [])).toStrictEqual(
		{ kind: 'findings', findings: 1 }
	)
	expect(
		getCoverageGap(covered, [
			botThread({ marker: { ...botThread().marker, kind: 'nit' } }),
		])
	).toStrictEqual({ kind: 'findings', findings: 1 })
	expect(
		getCoverageGap(
			{
				...covered,
				agents: first
					? [{ ...first, error: '1 of 2 units did not finish: LoopError' }]
					: [],
			},
			[]
		)?.kind
	).toBe('failed')
	expect(getCoverageGap(covered, [botThread()])).toBeUndefined()
})

for (const identity of [APP_IDENTITY, GITHUB_ACTIONS_IDENTITY])
	for (const mode of ['approve', 'preview'] as const)
		test(`${identity.login} with ${mode} decides approval by identity`, () => {
			expect(
				getApproval({ verdict: { ...DEFAULT_PRESET.verdict, mode } }, identity)
			).toBe(
				mode === 'preview'
					? 'preview'
					: identity === APP_IDENTITY
						? 'allowed'
						: 'token'
			)
		})

test('the preset permits an app to approve a covered review by default', () => {
	expect(DEFAULT_PRESET.verdict.mode).toBe('approve')
	expect(getApproval(DEFAULT_PRESET, APP_IDENTITY)).toBe('allowed')
	expect(getApproval(DEFAULT_PRESET, GITHUB_ACTIONS_IDENTITY)).toBe('token')
})

for (const condition of [
	'quick',
	'no-report',
	'incomplete-agent',
	'failed-agent',
	'unit-error',
	'agent-endpoint-error',
	'report-endpoint-error',
	'incomplete-report',
	'binary-plan',
	'too-large-plan',
	'binary-change',
	'too-large-change',
] as const)
	test(`${condition} cannot supply approval coverage`, () => {
		const covered = coveredReport()
		const { plan } = covered.planReport
		const withSkip = (files: typeof plan.files) =>
			files.map(
				file =>
					({
						...file,
						skipped: condition.startsWith('binary') ? 'binary' : 'too_large',
					}) as const
			)
		const reviewed = {
			...covered,
			agents:
				condition === 'no-report'
					? []
					: covered.agents.map(agent => ({
							...agent,
							...(condition === 'incomplete-agent'
								? { status: 'incomplete' as const }
								: {}),
							...(condition === 'failed-agent'
								? { status: 'failed' as const }
								: {}),
							...(condition === 'unit-error'
								? { error: '1 of 2 units did not finish: LoopError' }
								: {}),
							...(condition === 'agent-endpoint-error'
								? { endpointError: true }
								: {}),
						})),
			...(condition === 'report-endpoint-error'
				? { endpointError: 'Unavailable' }
				: {}),
			...(condition === 'incomplete-report'
				? { incomplete: { reason: 'budget spent', unfinished: ['reviewer'] } }
				: {}),
			planReport: {
				...covered.planReport,
				plan: {
					...plan,
					...(condition === 'quick'
						? {
								depth: 'quick' as const,
								runs: plan.runs.filter(run => run.role !== 'reviewer'),
							}
						: {}),
					...(condition.endsWith('-plan')
						? { files: withSkip(plan.files) }
						: {}),
				},
				change: {
					...covered.planReport.change,
					...(condition.endsWith('-change')
						? { files: withSkip(covered.planReport.change.files) }
						: {}),
				},
			},
		}
		expect(isCoveredBy(reviewed, [])).toBe(false)
	})

for (const kind of ['unverified', 'nit', 'bug'] as const)
	for (const resolved of [false, true])
		test(`coverage reads ${resolved ? 'resolved' : 'open'} ${kind} threads`, () => {
			expect(
				isCoveredBy(coveredReport(), [
					botThread({ resolved, marker: { ...botThread().marker, kind } }),
				])
			).toBe(resolved || kind === 'bug')
		})

test('files excluded by skip.paths still allow approval coverage', () => {
	const covered = coveredReport()
	expect(
		isCoveredBy(
			{
				...covered,
				planReport: {
					...covered.planReport,
					plan: {
						...covered.planReport.plan,
						files: covered.planReport.plan.files.map(file => ({
							...file,
							skipped: 'skip.paths',
						})),
					},
					change: {
						...covered.planReport.change,
						files: covered.planReport.change.files.map(file => ({
							...file,
							skipped: 'skip.paths',
						})),
					},
				},
			},
			[]
		)
	).toBeTruthy()
})

test('a deep plan cannot cover a planned reviewer model with no agent report', () => {
	const covered = coveredReport()
	const plan = buildPlan(
		planInput({
			config: {
				...DEFAULT_PRESET,
				depth: 'deep',
				models: {
					...DEFAULT_PRESET.models,
					reviewer: [
						{ model: 'model-a', effort: 'high' },
						{ model: 'model-b', effort: 'high' },
					],
				},
			},
		}),
		{ status: 'ok', risk: 'normal', added: [] }
	)
	expect(plan.runs.filter(run => run.role === 'reviewer')).toHaveLength(2)
	expect(
		isCoveredBy(
			{
				...covered,
				agents: [agentReport()],
				planReport: { ...covered.planReport, plan },
			},
			[]
		)
	).toBe(false)
})
