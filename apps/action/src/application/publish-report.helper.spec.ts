import { failsRating } from './publish-report.helper'
import type { PublishReport } from './publish-run.service'

describe('failsRating', () => {
	for (const [name, report, expected] of [
		['an unpublished run', { status: 'not-published', reason: 'skip' }, false],
		['a failure without a rating', { status: 'failed', reason: 'gone' }, false],
		[
			'a failed rating',
			{
				status: 'failed',
				reason: 'held read',
				risk: { status: 'failed', reason: 'held read' },
			},
			true,
		],
		[
			'an error that stands',
			{
				status: 'failed',
				reason: 'fixture',
				risk: {
					status: 'written',
					result: { state: 'error', level: 'low', reason: 'publish-failed' },
				},
			},
			false,
		],
		[
			'a grant that may still stand',
			{
				status: 'failed',
				reason: 'fixture',
				risk: {
					status: 'written',
					result: {
						state: 'error',
						level: 'low',
						reason: 'publish-failed',
						grantStands: true,
					},
				},
			},
			true,
		],
		...([0, 1] as const).map(
			unsettled =>
				[
					`a reply run leaving ${unsettled} answer unsettled`,
					{
						status: 'replied',
						result: {
							verdict: 'needs owner',
							event: 'COMMENT',
							dismissal: { dismissed: 0, failed: 0 },
							openBugs: 0,
							answered: { 'needs-owner': 1 },
							waiting: 1,
							label: 'added',
							run: 2,
							status: true,
							unsettled,
						},
					},
					unsettled > 0,
				] as const
		),
	] as const satisfies readonly (readonly [string, PublishReport, boolean])[])
		test(`${name} fails the job: ${expected}`, () => {
			expect(failsRating(report)).toBe(expected)
		})
})
