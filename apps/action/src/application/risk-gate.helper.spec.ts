import { DEFAULT_PRESET } from '@mng-review/domain'
import { GITHUB_ACTIONS_IDENTITY, toBotIdentity } from '@mng-review/github'
import {
	getRiskGate,
	getSettingsGate,
	type RiskGateInput,
} from './risk-gate.helper'

const INPUT = {
	config: { risk: { ...DEFAULT_PRESET.risk, enabled: true } },
	identity: toBotIdentity('mng-review'),
	settings: { environment: 'review-app', defaultBranch: 'main' },
	pr: { target: 'main' },
} as const satisfies RiskGateInput

describe('risk gate', () => {
	test('disabled risk has no requirements', () => {
		expect(
			getRiskGate({
				...INPUT,
				config: { risk: { ...INPUT.config.risk, enabled: false } },
				identity: GITHUB_ACTIONS_IDENTITY,
				settings: { environment: '', defaultBranch: '' },
			})
		).toEqual({ status: 'off' })
	})
	test('accepts the app in its environment on the default branch', () => {
		expect(getRiskGate(INPUT)).toEqual({ status: 'on' })
	})
	for (const scenario of [
		'job token',
		'empty environment',
		'other base',
		'unknown default',
	] as const)
		test(`refuses ${scenario} with one line`, () => {
			const gate = getRiskGate({
				...INPUT,
				identity:
					scenario === 'job token' ? GITHUB_ACTIONS_IDENTITY : INPUT.identity,
				settings: {
					...INPUT.settings,
					environment:
						scenario === 'empty environment' ? '' : INPUT.settings.environment,
					defaultBranch: scenario === 'unknown default' ? '' : 'main',
				},
				pr: { target: scenario === 'other base' ? 'develop' : 'main' },
			})
			expect(gate.status).toBe('refused')
			if (gate.status === 'refused') {
				expect(gate.reason).toMatch(/^not rated: /u)
				expect(gate.reason.split('\n')).toHaveLength(1)
			}
		})
	test('without rules the settings alone decide, so a run that would rate fails closed', () => {
		const { config: _config, ...settings } = INPUT
		expect(getSettingsGate(settings)).toEqual({ status: 'on' })
		expect(
			getSettingsGate({ ...settings, identity: GITHUB_ACTIONS_IDENTITY }).status
		).toBe('refused')
	})
})
