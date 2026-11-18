import { buildPlan, DEFAULT_PRESET, toFinding } from '@mng-review/domain'
import { type ReviewReport, toEmptyReviewReport } from '@mng-review/engine'
import { REPORTED_FINDING } from './review-cli.helper'

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
