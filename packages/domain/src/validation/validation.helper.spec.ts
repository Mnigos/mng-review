import { hasBlockingBug } from '../findings/finding-placement.helper'
import { agent, config, finding } from '../shared/mocks/domain-test.helper'
import {
	decideOutcome,
	getValidatorChoices,
	type OutcomeInput,
} from './validation.helper'
import type { Validation } from './validation.types'

/** Keeps the old behavior matrix independent of the service call shape. */
function runOutcome(
	bugs: OutcomeInput['bugs'],
	validations: OutcomeInput['validations'],
	nits: OutcomeInput['nits'],
	cfg: OutcomeInput['config'],
	agents: OutcomeInput['agents']
) {
	return decideOutcome({ bugs, validations, nits, config: cfg, agents })
}
const unvalidated: Validation = {
	status: 'unvalidated',
	error: 'two failed attempts',
}

describe('decideOutcome', () => {
	test('bugs below the global floor go to summary and cannot block', () => {
		const outcome = runOutcome(
			[finding({ severity: 'low' })],
			[unvalidated],
			[],
			config(),
			new Map()
		)
		expect(outcome.bugs).toMatchObject([
			{ severity: 'low', placement: 'summary', validation: unvalidated },
		])
		expect(hasBlockingBug(outcome.bugs)).toBe(false)
	})
	test('the floor is inclusive and unvalidated findings are retained', () => {
		const outcome = runOutcome(
			[finding()],
			[unvalidated],
			[],
			config(),
			new Map()
		)
		expect(outcome.bugs).toMatchObject([
			{ severity: 'medium', placement: 'inline', validation: unvalidated },
		])
		expect(hasBlockingBug(outcome.bugs)).toBe(true)
	})
	test('agent comments.min_severity overrides the global floor', () => {
		const agents = new Map([
			['strict', agent('strict', { comments: { min_severity: 'high' } })],
		])
		const outcome = runOutcome(
			[finding({ agents: ['strict'] })],
			[unvalidated],
			[],
			config(),
			agents
		)
		expect(outcome.bugs[0]?.placement).toBe('summary')
		expect(hasBlockingBug(outcome.bugs)).toBe(false)
	})
	test('merged findings use the lowest floor among all reporting agents', () => {
		const agents = new Map([
			['strict', agent('strict', { comments: { min_severity: 'critical' } })],
			['lenient', agent('lenient', { comments: { min_severity: 'low' } })],
		])
		const outcome = runOutcome(
			[
				finding({ agents: ['strict', 'lenient'], severity: 'low' }),
				finding({ agents: ['strict', 'reviewer'], line: 9 }),
			],
			[unvalidated, unvalidated],
			[],
			config(),
			agents
		)
		expect(outcome.bugs.map(bug => bug.placement)).toEqual(['inline', 'inline'])
	})
	test('confirmed re-rating affects placement and retains the originally reported severity', () => {
		const confirmed: Validation = {
			status: 'confirmed',
			model: 'model-b',
			severity: 'low',
			reason: 'Only a rare duplicate input.',
			evidence: ['src/billing/charge.ts:2 balance'],
		}
		const outcome = runOutcome(
			[finding({ severity: 'high' })],
			[confirmed],
			[],
			config(),
			new Map()
		)
		expect(outcome.bugs).toMatchObject([
			{
				severity: 'low',
				reportedSeverity: 'high',
				placement: 'summary',
				validation: confirmed,
			},
		])
		expect(hasBlockingBug(outcome.bugs)).toBe(false)
	})
	test('rejected findings retain the validator reason and evidence and cannot block', () => {
		const validation: Validation = {
			status: 'rejected',
			model: 'model-b',
			severity: 'low',
			reason: 'The caller deduplicates the invoice.',
			evidence: ['src/billing/charge.ts:1 unique invoice'],
		}
		const outcome = runOutcome(
			[finding()],
			[validation],
			[],
			config(),
			new Map()
		)
		expect(outcome.bugs).toEqual([])
		expect(outcome.rejected).toEqual([
			{
				...finding(),
				reason: validation.reason,
				evidence: validation.evidence,
				validatedBy: validation.model,
			},
		])
		expect(hasBlockingBug(outcome.bugs)).toBe(false)
	})
	test('missing validation is treated as unvalidated and kept', () => {
		const outcome = runOutcome([finding()], [], [], config(), new Map())
		expect(outcome.bugs[0]?.validation).toEqual({
			status: 'unvalidated',
			error: 'not validated',
		})
	})
	test('global and per-agent max_nits keep the most severe nits inline', () => {
		const agents = new Map([
			['style', agent('style', { kind: 'nit', comments: { max_nits: 1 } })],
		])
		const nits = [
			finding({ kind: 'nit', severity: 'low', agents: ['style'], line: 1 }),
			finding({
				kind: 'nit',
				severity: 'critical',
				agents: ['style'],
				line: 2,
			}),
			finding({ kind: 'nit', severity: 'medium', agents: ['other'], line: 3 }),
			finding({ kind: 'nit', severity: 'low', agents: ['other'], line: 4 }),
		]
		const outcome = runOutcome(
			[],
			[],
			nits,
			config({ comments: { max_nits: 2 } }),
			agents
		)
		expect(outcome.nits.map(nit => [nit.line, nit.placement])).toEqual([
			[2, 'inline'],
			[3, 'inline'],
			[1, 'summary'],
			[4, 'summary'],
		])
		expect(hasBlockingBug(outcome.bugs)).toBe(false)
		expect(nits[0]?.line).toBe(1)
	})
	test('zero global or agent max_nits moves nits to summary', () => {
		const nit = finding({ kind: 'nit', agents: ['style'] })
		expect(
			runOutcome(
				[],
				[],
				[nit],
				config({ comments: { max_nits: 0 } }),
				new Map()
			).nits[0]?.placement
		).toBe('summary')
		const agents = new Map([
			['style', agent('style', { kind: 'nit', comments: { max_nits: 0 } })],
		])
		expect(runOutcome([], [], [nit], config(), agents).nits[0]?.placement).toBe(
			'summary'
		)
	})
})

describe('getValidatorChoices', () => {
	const reviewers = [
		{ model: 'model-a', effort: 'high' },
		{ model: 'model-b', effort: 'high' },
	] as const
	test.each([
		[['model-a'], ['model-b', 'model-a']],
		[['model-b'], ['model-a', 'model-b']],
		[
			['model-a', 'model-b'],
			['model-a', 'model-b'],
		],
		[['declared-model'], ['model-a', 'model-b']],
	])('cross orders models for %j', (models, expected) => {
		expect(
			getValidatorChoices(
				finding({ models }),
				config({ models: { reviewer: [...reviewers], validator: 'cross' } })
			).map(entry => entry.model)
		).toEqual(expected)
	})
	test('a single reviewer cross-validates on the same model', () => {
		expect(
			getValidatorChoices(
				finding(),
				config({ models: { reviewer: [reviewers[0]], validator: 'cross' } })
			)
		).toEqual([reviewers[0]])
	})
	test.each(['validator', 'model-a', 'model-b'])(
		'explicit %s comes first without duplicates',
		model => {
			const validator = { model, effort: 'low' } as const
			expect(
				getValidatorChoices(
					finding(),
					config({ models: { reviewer: [...reviewers], validator } })
				)
			).toEqual([
				validator,
				...reviewers.filter(entry => entry.model !== model),
			])
		}
	)
})
