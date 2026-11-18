import {
	buildPlan,
	DEFAULT_PRESET,
	type KeptFinding,
	type ReportedFinding,
	toFinding,
} from '@mng-review/domain'
import { type ReviewReport, toEmptyReviewReport } from '@mng-review/engine'

const REPORTED_FINDING = {
	path: 'src/items/store.ts',
	line: 2,
	severity: 'medium',
	title: 'Duplicate write loses data',
	trigger: 'A write is retried.',
	impact: 'Data is overwritten.',
	evidence: ['src/items/store.ts:2'],
} as const satisfies ReportedFinding

/** A complete report exercises each output section with stable public values. */
export function reviewReport(): ReviewReport {
	const finding = toFinding(REPORTED_FINDING, {
		agent: 'reviewer',
		model: 'model-a',
		kind: 'bug',
	})
	const files = [
		{
			path: finding.path,
			status: 'modified',
			additions: 1,
			deletions: 1,
			binary: false,
			sizeBytes: 10,
		},
	] as const
	const pr = {
		labels: [],
		draft: false,
		fork: false,
		trigger: 'manual',
	} as const
	const planReport = {
		change: {
			base: { ref: 'main', commit: 'base' },
			head: { ref: 'HEAD', commit: 'head' },
			mergeBase: 'base',
			files,
		},
		plan: buildPlan(
			{ config: DEFAULT_PRESET, agents: [], files, pr },
			{ status: 'ok', risk: 'normal', added: [] }
		),
		rulesSource: 'working tree',
		tokens: {},
	} as const
	return {
		...toEmptyReviewReport(planReport, 1234),
		blocking: true,
		bugs: [
			{
				...finding,
				severity: 'high',
				reportedSeverity: 'medium',
				placement: 'inline',
				suggestion: 'Use a unique key.\nReject duplicate invoices.',
				validation: {
					status: 'confirmed',
					severity: 'high',
					reason: 'Duplicate retry charges twice.',
					evidence: ['src/billing/charge.ts:2'],
					model: 'model-b',
				},
			},
			{
				...finding,
				severity: 'low',
				title: 'Rare input',
				placement: 'summary',
				validation: { status: 'unvalidated', error: 'fixture failure' },
			},
		],
		nits: [
			{
				...finding,
				kind: 'nit',
				title: 'Use repository convention',
				placement: 'inline',
				suggestion: 'Rename to chargeInvoice.',
			},
			{
				...finding,
				kind: 'nit',
				title: 'Explain naming',
				placement: 'summary',
			},
		],
		rejected: [
			{
				...finding,
				title: 'Ownership guard',
				reason: 'Caller checks ownership.',
				validatedBy: 'model-b',
			},
		],
		agents: [
			{
				name: 'reviewer',
				title: 'Main reviewer',
				kind: 'bug',
				model: 'model-b',
				effort: 'high',
				status: 'ok',
				toolCalls: 3,
				findings: 2,
				malformed: 1,
				units: 2,
				fellBackFrom: 'model-a',
				wallMillis: 1200,
			},
			{
				name: 'agent',
				title: 'Agent',
				kind: 'bug',
				model: 'model-b',
				effort: 'high',
				status: 'failed',
				toolCalls: 0,
				findings: 0,
				malformed: 0,
				wallMillis: 34,
				error: 'fixture endpoint failure',
			},
		],
		tokenSources: {},
		tokens: {
			'model-b': {
				calls: 2,
				inputTokens: 6,
				cachedInputTokens: 0,
				outputTokens: 4,
				reasoningTokens: 1,
				totalTokens: 10,
			},
		},
		droppedModels: [{ model: 'model-a', reason: 'rate limited (429)' }],
	}
}

/** Two deep reviewer runs have distinct results and timings for summary row matching. */
export function deepReviewReport(): ReviewReport {
	const report = reviewReport()
	const plan = {
		...report.planReport.plan,
		depth: 'deep',
		depthSource: 'config',
		runs: report.planReport.plan.runs.flatMap(run =>
			['model-a', 'model-b'].map(model => ({ ...run, model }))
		),
	} as const
	return {
		...report,
		planReport: { ...report.planReport, plan },
		agents: plan.runs.map((run, index) => ({
			name: run.name,
			title: run.title,
			kind: run.kind,
			model: run.model,
			effort: run.effort,
			status: 'ok',
			findings: index + 1,
			toolCalls: index + 3,
			malformed: 0,
			wallMillis: (index + 1) * 1200,
		})),
		droppedModels: [],
	}
}

/** A dependency premise stays visible without producing an inline bug. */
export function unverifiedBug() {
	return {
		...toFinding(REPORTED_FINDING, {
			agent: 'reviewer',
			model: 'model-a',
			kind: 'bug',
		}),
		title: 'Callback receives a full URL',
		severity: 'high',
		placement: 'summary',
		validation: {
			status: 'unverified',
			severity: 'high',
			model: 'model-b',
			premise: 'Example Router passes a full URL to the callback.',
			reason: 'The filter only matches a path.',
			evidence: ['src/filter.ts:2 callback'],
		},
	} as const satisfies KeptFinding
}
