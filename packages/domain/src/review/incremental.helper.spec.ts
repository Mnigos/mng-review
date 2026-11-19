import { buildPlan } from '../routing/helpers/review-plan.helper'
import {
	planInput,
	plannedRun,
	NORMAL_ROUTER,
} from '../shared/mocks/domain-test.helper'
import { toIncrementalPlan } from './incremental.helper'

const SINCE = '0123456789abcdef'

describe('toIncrementalPlan', () => {
	test('incremental runs keep only changed paths without mutating the plan', () => {
		const run = plannedRun({ role: 'agent', files: ['src/a.ts', 'src/b.ts'] })
		const plan = { ...buildPlan(planInput(), NORMAL_ROUTER), runs: [run] }
		const narrowed = toIncrementalPlan(
			plan,
			new Set(['src/b.ts', 'src/other.ts']),
			SINCE
		)
		expect(narrowed.runs).toEqual([{ ...run, files: ['src/b.ts'] }])
		expect(plan.runs[0]?.files).toEqual(['src/a.ts', 'src/b.ts'])
	})
	test('empty incremental runs add one skip per name with the short commit and keep prior skips', () => {
		const skip = { name: 'old', title: 'Old agent', reason: 'path rules' }
		const plan = {
			...buildPlan(planInput(), NORMAL_ROUTER),
			runs: [
				plannedRun({ role: 'agent' }),
				plannedRun({ role: 'agent', model: 'model-b' }),
				plannedRun({ role: 'agent', name: 'storage' }),
			],
			skips: [skip],
		}
		expect(toIncrementalPlan(plan, new Set(), SINCE)).toMatchObject({
			runs: [],
			skips: [
				skip,
				{
					name: 'reviewer',
					title: 'Main reviewer',
					reason: 'no change since the last review at 01234567',
				},
				{
					name: 'storage',
					reason: 'no change since the last review at 01234567',
				},
			],
		})
	})
	test.each([{ changed: [] }, { changed: ['src/b.ts'] }])(
		'the incremental main reviewer keeps the whole change with changed paths %j',
		({ changed }) => {
			const run = plannedRun({
				role: 'reviewer',
				input: 'incremental',
				files: ['src/a.ts', 'src/b.ts'],
			})
			const plan = { ...buildPlan(planInput(), NORMAL_ROUTER), runs: [run] }
			const narrowed = toIncrementalPlan(plan, new Set(changed), SINCE)
			expect(narrowed.runs).toEqual([run])
			expect(narrowed.runs[0]).toBe(run)
			expect(narrowed.skips).toEqual(plan.skips)
		}
	)
	test.each(['full_diff', 'metadata'] as const)(
		'%s retains its original run even with no changed paths',
		input => {
			const run = plannedRun({
				role: 'agent',
				input,
				files: input === 'metadata' ? [] : ['src/a.ts'],
			})
			const plan = { ...buildPlan(planInput(), NORMAL_ROUTER), runs: [run] }
			expect(toIncrementalPlan(plan, new Set(), SINCE).runs[0]).toBe(run)
		}
	)
})
