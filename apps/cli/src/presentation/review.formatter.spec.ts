import type { Judgement, Unverified } from '@mng-review/domain'
import type { ReviewReport } from '@mng-review/engine'
import { Schema } from 'effect'
import {
	reviewReport,
	unverifiedBug,
} from '../shared/mocks/review-report.helper'
import { formatReviewJson, formatReviewText } from './review.formatter'

const decodeJson = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Unknown)
)

describe('review formatters', () => {
	test('text and JSON keep partial findings, name unfinished work and distinguish budget-stopped validation', () => {
		const fixture = reviewReport()
		const report: ReviewReport = {
			...fixture,
			bugs: fixture.bugs.map(bug => ({
				...bug,
				validation: {
					status: 'unvalidated',
					budgetSpent: true,
					error: 'token budget spent',
				},
			})),
			agents: fixture.agents.map(agent => ({
				...agent,
				status: 'incomplete',
				unfinished: ['src/viewer.ts: close()'],
			})),
			incomplete: {
				reason: 'limits.tokens_per_run (100) reached',
				unfinished: [
					'reviewer: src/viewer.ts: close()',
					'validation of 2 finding(s)',
				],
			},
		}
		const text = formatReviewText(report)
		expect(text).toContain(fixture.bugs[0]?.title ?? '')
		expect(text).toContain(
			'validator: not run, token budget spent; kept unvalidated'
		)
		expect(text).not.toContain('no answer after two attempts')
		expect(text).toContain('reviewer  incomplete')
		expect(text).toContain('; did not finish: src/viewer.ts: close()')
		expect(text).toContain(
			'Incomplete run, limits.tokens_per_run (100) reached; the findings above are partial. Did not finish:\n  reviewer: src/viewer.ts: close()\n  validation of 2 finding(s)'
		)
		expect(decodeJson(formatReviewJson(report))).toMatchObject({
			bugs: report.bugs,
			agents: report.agents,
			incomplete: report.incomplete,
			endpointError: null,
		})
	})
	test('text shows bug provenance, validation, severity re-rating and suggestions', () => {
		const report = reviewReport()
		for (const text of [
			'Bugs (1):',
			'HIGH (reported medium)',
			'src/billing/charge.ts:2',
			report.bugs[0]?.title ?? '',
			'agents: reviewer; models: model-a; fingerprint',
			report.bugs[0]?.fingerprint ?? '',
			'trigger: Invoice retry',
			'impact: The balance is charged twice.',
			'evidence: src/billing/charge.ts:2',
			'validator (model-b): confirmed. Duplicate retry charges twice.',
			'suggestion: Use a unique key.\n      Reject duplicate invoices.',
		])
			expect(formatReviewText(report)).toContain(text)
	})
	test('text shows below-floor bugs, unvalidated reasons, inline and summary nits, rejected reasons and models', () => {
		const text = formatReviewText(reviewReport())
		for (const part of [
			'Below the severity floor (1):',
			'Rare input',
			'validator: no answer after two attempts, kept (fixture failure)',
			'Nits (1 inline, 1 in the summary):',
			'Explain naming [reviewer] (summary)',
			'Rejected by the validator (1):',
			'rejected by model-b: Caller checks ownership.',
		])
			expect(text).toContain(part)
	})
	test('text shows each nit with its trigger, impact, evidence and suggestion under its heading', () => {
		const [nit] = reviewReport().nits
		expect(formatReviewText(reviewReport())).toContain(
			[
				`  ${nit?.path}:${nit?.line}  Use repository convention [reviewer]`,
				`    trigger: ${nit?.trigger}`,
				`    impact: ${nit?.impact}`,
				...(nit?.evidence ?? []).map(line => `    evidence: ${line}`),
				'    suggestion: Rename to chargeInvoice.',
			].join('\n')
		)
	})
	test('text shows agent status, tool calls, units, fallback, malformed, tokens, dropped reason and wall time', () => {
		const text = formatReviewText(reviewReport())
		for (const part of [
			'reviewer  ok, model-b high, 3 tool calls, 2 findings, 2 units, 1 malformed dropped, 1.2 s; model-a was dropped',
			'agent  failed',
			'fixture endpoint failure',
			'model-b  10 (6 in, 0 cached, 4 out, 2 call(s))',
			'Degraded run, models dropped:\n  model-a  rate limited (429)',
			'Wall time: 1.2 s',
		])
			expect(text).toContain(part)
	})
	test('JSON preserves every outcome field and plan field and uses null for an absent endpoint error', () => {
		const report = reviewReport()
		expect(decodeJson(formatReviewJson(report))).toMatchObject({
			base: report.planReport.change.base,
			head: report.planReport.change.head,
			mergeBase: 'base',
			bugs: report.bugs,
			nits: report.nits,
			rejected: report.rejected,
			agents: report.agents,
			tokens: report.tokens,
			droppedModels: report.droppedModels,
			wallMillis: report.wallMillis,
			blocking: true,
			endpointError: null,
			incomplete: null,
		})
	})
	test('unverified bugs have a section after below-floor bugs with their premise and do not increase the Bugs count', () => {
		const fixture = reviewReport()
		const unverified = unverifiedBug()
		const report: ReviewReport = {
			...fixture,
			bugs: [...fixture.bugs, unverified],
		}
		const text = formatReviewText(report)
		const heading =
			"Unverified, resting on a dependency's behaviour, never blocking (1):"
		expect(text).toContain('Bugs (1):')
		expect(text).toContain('Below the severity floor (1):')
		expect(text).toContain(heading)
		expect(text.indexOf(heading)).toBeGreaterThan(
			text.indexOf('Below the severity floor (1):')
		)
		expect(text.indexOf(heading)).toBeLessThan(text.indexOf('Nits ('))
		expect(text.indexOf(unverified.title)).toBeGreaterThan(
			text.indexOf(heading)
		)
		expect(text).toContain(
			`validator (${unverified.validation.model}): unverified, rests on: ${unverified.validation.premise} ${unverified.validation.reason}`
		)
		expect(text).toContain(unverified.validation.evidence[0])
	})
	test('JSON retains unverified bugs and their validation when they are the only bugs', () => {
		const fixture = reviewReport()
		const report: ReviewReport = {
			...fixture,
			blocking: false,
			bugs: [unverifiedBug()],
		}
		expect(decodeJson(formatReviewJson(report))).toMatchObject({
			bugs: report.bugs,
			blocking: false,
		})
		expect(formatReviewText(report)).toContain('Bugs (0):\n  (none)')
	})
	test('endpoint error is present in both formats', () => {
		const report = {
			...reviewReport(),
			endpointError: 'reviewer: endpoint failed',
		}
		expect(formatReviewText(report)).toContain(
			'Endpoint error: reviewer: endpoint failed'
		)
		expect(decodeJson(formatReviewJson(report))).toMatchObject({
			endpointError: report.endpointError,
		})
	})
	test('skipped report prints only the plan and JSON retains the empty outcome', () => {
		const fixture = reviewReport()
		const report = {
			...fixture,
			bugs: [],
			nits: [],
			rejected: [],
			agents: [],
			tokens: {},
			droppedModels: [],
			blocking: false,
			planReport: {
				...fixture.planReport,
				plan: {
					...fixture.planReport.plan,
					skippedRun: 'label skip-review is in skip.labels',
					runs: [],
				},
			},
		}
		const text = formatReviewText(report)
		expect(text).toContain('label skip-review is in skip.labels')
		expect(text).not.toContain('Bugs (')
		expect(text).not.toContain('Wall time:')
		expect(decodeJson(formatReviewJson(report))).toMatchObject({
			skipped: 'label skip-review is in skip.labels',
			bugs: [],
			nits: [],
			rejected: [],
			agents: [],
			tokens: {},
		})
	})
	test('empty active report prints no bugs and omits empty optional sections', () => {
		const fixture = reviewReport()
		const text = formatReviewText({
			...fixture,
			bugs: [],
			nits: [],
			rejected: [],
			agents: [],
			tokens: {},
			droppedModels: [],
			blocking: false,
		})
		expect(text).toContain('Bugs (0):\n  (none)')
		for (const part of [
			'Nits (',
			'Rejected by',
			'Degraded run',
			'Agents:',
			'Tokens:',
			'Incomplete run',
		])
			expect(text).not.toContain(part)
	})
})

test('review text and JSON carry source token accounting', () => {
	const fixture = reviewReport()
	const entry = {
		calls: 2,
		inputTokens: 100,
		cachedInputTokens: 40,
		outputTokens: 10,
		reasoningTokens: 0,
		totalTokens: 110,
		conversations: 1,
		firstMessageTokens: 60,
		historyTokens: 40,
	} as const
	const report = {
		...fixture,
		tokenSources: {
			reviewer: entry,
			validator: { ...entry, conversations: 2 },
		},
	}
	expect(formatReviewText(report)).toContain(
		'Tokens by finder and validator:\n  reviewer  110 (60 first messages, 40 history, 40 cached, 10 out, 2 call(s), 1 conversation(s))\n  validator  110 (60 first messages, 40 history, 40 cached, 10 out, 2 call(s), 2 conversation(s))'
	)
	expect(decodeJson(formatReviewJson(report))).toMatchObject({
		tokenSources: report.tokenSources,
	})
})

for (const status of ['confirmed', 'unverified'] as const)
	test(`review text and JSON show lowering explanations and engine notes for ${status} findings`, () => {
		const fixture = reviewReport()
		const original = unverifiedBug()
		const loweredBecause =
			'high: no main flow fails and no wrong data is returned.'
		const note =
			'Kept the reported severity because the criterion was not named.'
		const validation = {
			...original.validation,
			status,
			severity: 'medium',
			loweredBecause,
			note,
		} as const satisfies Judgement | Unverified
		const report: ReviewReport = {
			...fixture,
			bugs: [
				{
					...original,
					severity: 'medium',
					reportedSeverity: 'high',
					validation,
				},
			],
		}
		const text = formatReviewText(report)
		expect(text).toContain(`      lowered because: ${loweredBecause}`)
		expect(text).toContain(`      note: ${note}`)
		expect(decodeJson(formatReviewJson(report))).toMatchObject({
			bugs: [{ validation: { loweredBecause, note } }],
		})
	})

test('review text omits lowering and note labels when the validator supplied neither', () => {
	const text = formatReviewText(reviewReport())
	expect(text).not.toContain('lowered because:')
	expect(text).not.toContain('note:')
})
