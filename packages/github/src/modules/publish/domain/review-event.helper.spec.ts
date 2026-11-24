import { DEFAULT_PRESET } from '@mng-review/domain'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import {
	agentReport,
	APP_IDENTITY,
	botThread,
	report,
} from '../../../shared/mocks/publish-test.helper'
import { getCoverageGap } from './coverage-gap.helper'
import {
	getApproval,
	getReviewDecision,
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
] as const satisfies readonly DecisionCase[]

test.each(CASES)('$name', scenario => {
	expect(getReviewDecision(scenario.input)).toStrictEqual(scenario.expected)
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
