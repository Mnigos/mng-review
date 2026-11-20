import type { ReviewReport } from '@mng-review/engine'
import { agentReport, bug, report } from './publish-test.helper'

export const BASE_SHA = 'a'.repeat(40)
export const HEAD_SHA = 'b'.repeat(40)

/** A complete report uses real-shaped commits and covers every field crossing the file boundary. */
export function reviewReport(): ReviewReport {
	const fixture = report()
	const { placement: _placement, ...finding } = bug()
	const tokens = {
		'model-a': {
			calls: 2,
			inputTokens: 10,
			cachedInputTokens: 2,
			outputTokens: 5,
			reasoningTokens: 1,
			totalTokens: 15,
		},
	} as const
	return {
		...fixture,
		bugs: [
			bug({
				reportedSeverity: 'medium',
				suggestion: 'Guard the write.',
				validation: {
					status: 'confirmed',
					severity: 'high',
					reason: 'The write repeats.',
					evidence: ['src/store.ts:10'],
					model: 'model-a',
					loweredBecause: 'The caller checks access.',
					note: 'Keep the guard.',
				},
			}),
		],
		nits: [bug({ kind: 'nit', placement: 'summary' })],
		rejected: [
			{ ...finding, reason: 'The guard covers it.', validatedBy: 'model-a' },
		],
		planReport: {
			...fixture.planReport,
			change: {
				...fixture.planReport.change,
				base: { ref: 'main', commit: BASE_SHA },
				head: { ref: 'HEAD', commit: HEAD_SHA },
				mergeBase: BASE_SHA,
				files: fixture.planReport.change.files.map(file => ({
					...file,
					oldPath: 'src/old-store.ts',
					status: 'renamed',
				})),
			},
			plan: {
				...fixture.planReport.plan,
				shape: {
					files: 1,
					smallShare: 1,
					netShare: 0,
					riskyRewrites: [],
					failed: [],
				},
				router: {
					status: 'ok',
					risk: 'normal',
					detail: 'One changed module.',
					signals: [
						{
							category: 'stored_data',
							path: 'src/store.ts',
							reason: 'Writes data.',
						},
					],
					added: [],
				},
				skips: [
					{ name: 'docs', title: 'Documentation', reason: 'No matching path.' },
				],
			},
			tokens,
		},
		agents: [
			{
				...agentReport('incomplete'),
				units: 2,
				continued: 1,
				unfinished: ['unit-2'],
				error: 'Budget exhausted.',
				endpointError: false,
				fellBackFrom: 'model-b',
			},
		],
		tokens,
		tokenSources: {
			reviewer: {
				...tokens['model-a'],
				conversations: 2,
				firstMessageTokens: 8,
				historyTokens: 2,
			},
		},
		droppedModels: [{ model: 'model-b', reason: 'Unavailable.' }],
		wallMillis: 123,
		endpointError: 'Unavailable model.',
		incomplete: { reason: 'Budget exhausted.', unfinished: ['unit-2'] },
		blocking: true,
	}
}
