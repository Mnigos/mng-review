import { config } from '../../../shared/mocks/domain-test.helper'
import {
	MODEL,
	REVIEWERS,
	reviewRequest,
} from '../../../shared/mocks/review-test.helper'
import type { AgentRunReport } from '../../review/domain/review-report.types'
import {
	getRaterChoices,
	getReviewGap,
	isRatingRun,
} from './risk-rating.helper'

const FINDER = {
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

describe('getRaterChoices', () => {
	test('validator uses an explicit validator model', () => {
		const validator = { model: 'validator', effort: 'medium' } as const
		expect(
			getRaterChoices(config({ models: { reviewer: REVIEWERS, validator } }))
		).toEqual([validator, ...REVIEWERS])
	})
	test('validator falls back to reviewers in their configured order', () => {
		expect(
			getRaterChoices(
				config({ models: { reviewer: REVIEWERS, validator: 'cross' } })
			)
		).toEqual(REVIEWERS)
	})
	test('an explicit risk model precedes validator choices without repeating a reviewer', () => {
		const cfg = config({ models: { reviewer: REVIEWERS, validator: 'cross' } })
		expect(
			getRaterChoices({ ...cfg, risk: { ...cfg.risk, model: REVIEWERS[1] } })
		).toEqual([REVIEWERS[1], MODEL])
	})
	test('a distinct explicit risk model precedes an explicit validator', () => {
		const cfg = config({ models: { reviewer: REVIEWERS, validator: MODEL } })
		const model = { model: 'rater', effort: 'low' } as const
		expect(getRaterChoices({ ...cfg, risk: { ...cfg.risk, model } })).toEqual([
			model,
			...REVIEWERS,
		])
	})
})

describe('isRatingRun', () => {
	const request = reviewRequest()
	const enabled = config({ risk: { ...config().risk, enabled: true } })
	test.each([
		['enabled full run', enabled, undefined, undefined, true],
		['disabled', config(), undefined, undefined, false],
		['named agent', enabled, 'storage', undefined, false],
		['gate skip', enabled, undefined, 'draft', false],
	] as const)('%s', (_name, cfg, onlyAgent, skippedRun, expected) => {
		expect(
			isRatingRun({
				config: cfg,
				onlyAgent,
				plan: { ...request.planReport.plan, skippedRun },
			})
		).toBe(expected)
	})
})

describe('getReviewGap', () => {
	test('a finished review leaves no gap', () => {
		expect(getReviewGap({ agents: [FINDER] })).toBeUndefined()
	})
	test.each([
		[
			'a failed finder without an endpoint error',
			{ ...FINDER, status: 'failed', error: 'agent gave no valid answer' },
			'run-failed',
		],
		[
			'a finder whose units only partly ran',
			{ ...FINDER, units: 2, error: '1 of 2 units did not finish: boom' },
			'run-failed',
		],
		[
			'a finder the budget stopped',
			{ ...FINDER, status: 'incomplete', unfinished: ['reviewer'] },
			'budget-stopped',
		],
	] as const)('%s leaves the run unrated', (_name, finder, reason) => {
		const gap = getReviewGap({
			agents: [FINDER, { ...finder, name: 'storage' }],
		})
		expect(gap?.reason).toBe(reason)
		expect(gap?.detail).toContain('finder storage')
	})
	test('an endpoint error comes before the finder reports', () => {
		expect(
			getReviewGap({
				agents: [{ ...FINDER, status: 'failed', error: 'x' }],
				endpointError: 'Finder failed.',
			})
		).toEqual({ reason: 'run-failed', detail: 'Finder failed.' })
	})
})
