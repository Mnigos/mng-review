import { Schema } from 'effect'
import { reviewReport } from '../shared/mocks/review-report.helper'
import { formatReviewJson, formatReviewText } from './review.formatter'

const decodeJson = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Unknown)
)

describe('review formatters', () => {
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
			'model-b  10 (6 in, 4 out, 2 call(s))',
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
		})
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
		])
			expect(text).not.toContain(part)
	})
})
