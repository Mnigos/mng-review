import { buildPlan } from '../routing/helpers/review-plan.helper'
import {
	agent,
	config,
	file,
	NORMAL_ROUTER,
	planInput,
	plannedRun,
} from '../shared/mocks/domain-test.helper'
import { toAgentOnlyPlan, toUnknownAgentPlan } from './agent-plan.helper'

describe('toAgentOnlyPlan', () => {
	test('keeps every already planned run for the agent without changing its files or settings', () => {
		const requested = agent('storage')
		const input = planInput({ agents: [requested] })
		const plan = buildPlan(input, NORMAL_ROUTER)
		const runs = [
			plannedRun({
				name: 'storage',
				role: 'agent',
				model: 'first',
				files: ['src/a.ts'],
				selectedBy: 'router',
				reason: 'router evidence',
			}),
			plannedRun({
				name: 'storage',
				role: 'agent',
				model: 'second',
				effort: 'low',
				files: ['src/b.ts'],
			}),
		]
		const original = {
			...plan,
			runs: [plannedRun(), ...runs, plannedRun({ model: 'other' })],
		}
		const snapshot = structuredClone(original)
		const narrowed = toAgentOnlyPlan(original, requested, input.config)
		expect(narrowed.runs).toEqual(runs)
		expect(narrowed.skips.filter(skip => skip.name === 'reviewer')).toEqual([
			{
				name: 'reviewer',
				title: 'Main reviewer',
				reason: 'a command asked for another agent',
			},
		])
		expect(original).toEqual(snapshot)
		expect({ ...narrowed, runs: original.runs, skips: original.skips }).toEqual(
			original
		)
	})
	test.each([false, true])(
		'builds an unplanned agent run with front matter overrides=%s on all unskipped files',
		override => {
			const requested = agent('storage', {
				kind: 'nit',
				input: 'full_diff',
				when: { paths: ['unmatched/**'] },
				...(override ? { model: 'agent-model', effort: 'xhigh' } : {}),
			})
			const cfg = config({
				models: { agents: { model: 'configured-model', effort: 'low' } },
			})
			const plan = buildPlan(
				planInput({
					config: cfg,
					agents: [requested],
					files: [
						file('src/a.ts'),
						file('src/b.ts'),
						file('ignored.bin', { skipped: 'binary' }),
					],
				}),
				NORMAL_ROUTER
			)
			expect(plan.runs.some(run => run.name === requested.name)).toBe(false)
			expect(toAgentOnlyPlan(plan, requested, cfg).runs).toEqual([
				{
					name: requested.name,
					title: requested.title,
					role: 'agent',
					kind: 'nit',
					input: 'full_diff',
					model: override ? 'agent-model' : 'configured-model',
					effort: override ? 'xhigh' : 'low',
					files: ['src/a.ts', 'src/b.ts'],
					selectedBy: 'default',
					reason: 'requested by a command',
				},
			])
		}
	)
	test('preserves existing skips and adds one skip per other run name', () => {
		const requested = agent('storage')
		const input = planInput()
		const plan = buildPlan(input, NORMAL_ROUTER)
		const existing = {
			name: 'unselected',
			title: 'Unselected',
			reason: 'no matching files',
		}
		const narrowed = toAgentOnlyPlan(
			{
				...plan,
				skips: [existing],
				runs: [
					plannedRun(),
					plannedRun({ model: 'second' }),
					plannedRun({ name: 'security', title: 'Security', role: 'agent' }),
					plannedRun({
						name: 'security',
						title: 'Security',
						role: 'agent',
						model: 'second',
					}),
				],
			},
			requested,
			input.config
		)
		expect(narrowed.skips).toEqual([
			existing,
			{
				name: 'reviewer',
				title: 'Main reviewer',
				reason: 'a command asked for another agent',
			},
			{
				name: 'security',
				title: 'Security',
				reason: 'a command asked for another agent',
			},
		])
	})
})

describe('toUnknownAgentPlan', () => {
	for (const name of ['storage', 'storage-2', '2-storage'])
		test(`names the undeclared agent ${name} and clears planned runs and skips`, () => {
			const original = {
				...buildPlan(planInput(), NORMAL_ROUTER),
				skips: [{ name: 'other', title: 'Other', reason: 'no matching files' }],
			}
			const snapshot = structuredClone(original)
			expect(toUnknownAgentPlan(original, name)).toEqual({
				...original,
				skippedRun: `a command named agent ${name}, which the rules do not declare`,
				runs: [],
				skips: [],
			})
			expect(original).toEqual(snapshot)
		})
	for (const name of [
		'',
		'Storage',
		'-storage',
		'storage agent',
		'storage\nextra',
		'<agent>',
	])
		test(`does not repeat an invalid agent name ${JSON.stringify(name)}`, () => {
			const plan = buildPlan(planInput(), NORMAL_ROUTER)
			expect(toUnknownAgentPlan(plan, name)).toEqual({
				...plan,
				skippedRun: 'a command named an agent, which the rules do not declare',
				runs: [],
				skips: [],
			})
		})
})
