import { toRiskDescription } from '../risk-description.parser'
import type { RiskLevel } from '../risk-description.schema'
import { RATED_LEVELS, STATUS_LEVELS } from '../risk.constants'
import type { RiskSources, RiskStatus } from '../risk.types'
import {
	getCombinedLevel,
	getHeldLevel,
	getStepOneLevel,
	isRiskGrant,
} from './risk-level.helper'

const SOURCES = {
	model: 'low',
	floors: [],
	routerRisky: false,
	confirmedBugs: [],
	markerHighest: 'none',
	held: 'none',
} as const satisfies RiskSources

/** A status for a selected pull request and rated level. */
function status(
	level: RiskLevel | 'none',
	state = 'success',
	pr = 42
): RiskStatus {
	return {
		state,
		description: toRiskDescription({
			pr,
			level,
			floor: false,
			base: 'a'.repeat(40),
			rules: 'b'.repeat(12),
			nonce: 'c'.repeat(16),
		}),
	}
}

describe('combined and step-one levels', () => {
	test.each(STATUS_LEVELS)(
		'retains held and marker level %s for every model level',
		previous => {
			for (const model of RATED_LEVELS) {
				const expected =
					STATUS_LEVELS.indexOf(previous) > STATUS_LEVELS.indexOf(model)
						? previous
						: model
				expect(getCombinedLevel({ ...SOURCES, model, held: previous })).toBe(
					expected
				)
				expect(
					getCombinedLevel({ ...SOURCES, model, markerHighest: previous })
				).toBe(expected)
				expect(getStepOneLevel(previous, model)).toBe(expected)
			}
			expect(getStepOneLevel(previous)).toBe(previous)
		}
	)
	test.each([
		[
			{ floors: [{ level: 'medium' }, { level: 'high' }, { level: 'low' }] },
			'high',
		],
		[{ floors: [{ level: 'medium' }] }, 'medium'],
		[{ routerRisky: true }, 'medium'],
		[{ routerRisky: true, model: 'high' }, 'high'],
		[{ confirmedBugs: ['high'] }, 'high'],
		[{ confirmedBugs: ['critical'] }, 'high'],
		[{ confirmedBugs: ['low', 'medium'] }, 'low'],
		[{ confirmedBugs: [] }, 'low'],
		[{ model: 'medium' }, 'medium'],
		[{ held: 'high', markerHighest: 'medium', routerRisky: true }, 'high'],
	] as const)('combines %j to %s', (overrides, expected) => {
		expect(getCombinedLevel({ ...SOURCES, ...overrides })).toBe(expected)
	})
})

describe('held statuses', () => {
	test('counts an error level and ignores other pull requests and malformed descriptions', () => {
		expect(
			getHeldLevel(
				[
					status('low'),
					status('medium', 'error'),
					status('high', 'failure', 43),
					{ state: 'error', description: 'high' },
				],
				42
			)
		).toBe('medium')
	})
	test.each(['success', 'failure', 'error'])(
		'holds High on %s even if a later status says Low',
		state => {
			expect(getHeldLevel([status('high', state), status('low')], 42)).toBe(
				'high'
			)
		}
	)
	test.each([
		{ statuses: [] },
		{ statuses: [status('high', 'error', 43)] },
		{ statuses: [{ state: 'success', description: 'invalid' }] },
		{ statuses: [status('none', 'error')] },
	])('has no held level for %j', ({ statuses }) => {
		expect(getHeldLevel(statuses, 42)).toBe('none')
	})
	test('ignores malformed descriptions mixed into valid history', () => {
		expect(
			getHeldLevel(
				[
					status('medium'),
					{ ...status('high'), description: `${status('high').description} ` },
				],
				42
			)
		).toBe('medium')
	})
})

describe('risk grants', () => {
	test.each(STATUS_LEVELS)(
		'success at %s grants only at Low or Medium',
		level => {
			expect(isRiskGrant(status(level), 42)).toBe(
				level === 'low' || level === 'medium'
			)
		}
	)
	test.each(['failure', 'error', 'pending', 'SUCCESS'])(
		'never grants state %s',
		state => {
			expect(isRiskGrant(status('low', state), 42)).toBe(false)
		}
	)
	test.each(['low', 'medium'] as const)(
		'never grants %s when a floor applied',
		level => {
			const floored = status(level)
			expect(
				isRiskGrant(
					{
						...floored,
						description: floored.description.replace('floor=-', 'floor=yes'),
					},
					42
				)
			).toBe(false)
		}
	)
	test('a grant belongs only to the number in its description', () => {
		expect(isRiskGrant(status('low'), 43)).toBe(false)
	})
	test.each([
		['trailing space', `${status('low').description} `],
		[
			'uppercase hex',
			status('low').description.replace('a'.repeat(40), 'A'.repeat(40)),
		],
		['leading zero', status('low').description.replace('pr=42', 'pr=042')],
		['other version', status('low').description.replace('v1', 'v2')],
	] as const)('rejects %s', (_name, description) => {
		expect(isRiskGrant({ state: 'success', description }, 42)).toBe(false)
	})
	test('never grants a description with a trailing newline', () => {
		expect(
			isRiskGrant(
				{ ...status('low'), description: `${status('low').description}\n` },
				42
			)
		).toBe(false)
	})
})
