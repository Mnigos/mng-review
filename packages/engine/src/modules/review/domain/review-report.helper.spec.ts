import { LIMITS } from '../../../shared/mocks/review-test.helper'
import { toIncompleteRun } from './review-report.helper'
import type { AgentRunReport } from './review-report.types'

const AGENT = {
	name: 'reviewer',
	title: 'Main reviewer',
	kind: 'bug',
	model: 'model-a',
	effort: 'high',
	status: 'ok',
	toolCalls: 0,
	findings: 0,
	malformed: 0,
	wallMillis: 0,
} as const satisfies AgentRunReport

describe('toIncompleteRun', () => {
	test('names unfinished agents and units and counts only validations stopped by the budget', () => {
		expect(
			toIncompleteRun({
				agents: [
					{
						...AGENT,
						status: 'incomplete',
						unfinished: ['viewer.ts: close()', 'export.ts'],
					},
					{ ...AGENT, name: 'ui', status: 'incomplete', unfinished: ['ui'] },
				],
				validations: [
					{
						status: 'unvalidated',
						error: 'token budget spent',
						budgetSpent: true,
					},
					{ status: 'unvalidated', error: 'invalid answer' },
					{
						status: 'unvalidated',
						error: 'token budget spent',
						budgetSpent: true,
					},
					{
						status: 'confirmed',
						model: 'model-b',
						severity: 'high',
						reason: 'Confirmed.',
						evidence: [],
					},
				],
				tokensPerRun: LIMITS.tokensPerRun,
			})
		).toEqual({
			reason: `limits.tokens_per_run (${LIMITS.tokensPerRun}) reached`,
			unfinished: [
				'reviewer: viewer.ts: close()',
				'reviewer: export.ts',
				'ui',
				'validation of 2 finding(s)',
			],
		})
	})
	test('non-budget failures and ordinary unvalidated answers do not mark a run incomplete', () => {
		expect(
			toIncompleteRun({
				agents: [{ ...AGENT, status: 'failed', error: 'endpoint failure' }],
				validations: [
					{ status: 'unvalidated', error: 'invalid answer' },
					{
						status: 'unvalidated',
						error: 'not a budget stop',
						budgetSpent: false,
					},
				],
				tokensPerRun: LIMITS.tokensPerRun,
			})
		).toBeUndefined()
	})
	test('an empty run has no incomplete marker', () => {
		expect(
			toIncompleteRun({
				agents: [],
				validations: [],
				tokensPerRun: LIMITS.tokensPerRun,
			})
		).toBeUndefined()
	})
})
