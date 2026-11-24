import type { RiskReport } from '../application/risk-run.service'
import { withRiskText } from './risk-summary.formatter'

describe('risk summary', () => {
	test('disabled risk leaves the publish line unchanged', () => {
		expect(
			withRiskText('published', {
				status: 'failed',
				reason: 'fixture',
				risk: { status: 'off' },
			})
		).toBe('published')
	})
	for (const [risk, expected] of [
		[
			{ status: 'refused', reason: 'not rated: needs app' },
			'not rated: needs app',
		],
		[
			{ status: 'failed', reason: 'held read' },
			'stopped before step 1: held read',
		],
		[{ status: 'none' }, 'nothing to raise'],
		[
			{ status: 'written', result: { state: 'success', level: 'low' } },
			'success at low',
		],
		[
			{ status: 'written', result: { state: 'failure', level: 'high' } },
			'failure at high',
		],
		[
			{
				status: 'written',
				result: { state: 'error', level: 'high', reason: 'publish-failed' },
			},
			'not rated (publish-failed), error at high',
		],
		[
			{
				status: 'written',
				result: {
					state: 'error',
					level: 'low',
					reason: 'publish-failed',
					grantStands: true,
				},
			},
			'not rated (publish-failed), error at low, the grant may stand until the cleanup step',
		],
		[
			{
				status: 'written',
				result: { state: 'none', level: 'none', labelFailed: true },
			},
			'nothing written, a label write failed',
		],
	] as const satisfies readonly (readonly [RiskReport, string])[])
		test(`reports ${expected}`, () => {
			expect(
				withRiskText('published', { status: 'failed', reason: 'fixture', risk })
			).toBe(`published; risk: ${expected}`)
		})
})
