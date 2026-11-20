import { DEFAULT_PRESET } from '../../config/review-config.constants'
import { config, pr } from '../../shared/mocks/domain-test.helper'
import { DEPTH_FOR_RISK } from '../routing.constants'
import { resolveDepth } from './depth.helper'

describe('depth precedence', () => {
	test('risk paths override deep/quick labels and a fixed quick setting', () => {
		const cfg = config({ depth: 'quick' })
		const info = pr({ labels: [cfg.labels.depth.deep, cfg.labels.depth.quick] })
		expect(
			resolveDepth(cfg, info, 'trivial', ['src/billing/invoice.ts'])
		).toEqual({ depth: 'deep', source: 'risk_paths' })
	})
	test('deep label wins over quick label and fixed setting', () => {
		const cfg = config({ depth: 'balanced' })
		expect(
			resolveDepth(
				cfg,
				pr({ labels: [cfg.labels.depth.quick, cfg.labels.depth.deep] }),
				'trivial',
				[]
			)
		).toEqual({ depth: 'deep', source: `label ${cfg.labels.depth.deep}` })
	})
	test('quick label wins over fixed deep setting and risky rating', () => {
		const cfg = config({ depth: 'deep' })
		expect(
			resolveDepth(cfg, pr({ labels: [cfg.labels.depth.quick] }), 'risky', [])
		).toEqual({ depth: 'quick', source: `label ${cfg.labels.depth.quick}` })
	})
	test.each(['quick', 'balanced', 'deep'] as const)(
		'fixed %s overrides risk',
		depth => {
			expect(resolveDepth(config({ depth }), pr(), 'risky', [])).toEqual({
				depth,
				source: 'review.yml depth',
			})
		}
	)
	for (const risk of ['trivial', 'normal', 'risky'] as const)
		test(`maps risk ${risk} to ${DEPTH_FOR_RISK[risk]}`, () => {
			expect(resolveDepth(config(), pr(), risk, [])).toEqual({
				depth: DEPTH_FOR_RISK[risk],
				source: `risk ${risk}`,
			})
		})
	test('uses configured depth labels rather than preset labels', () => {
		const cfg = config({
			labels: { depth: { quick: 'fast', deep: 'thorough' } },
		})
		expect(resolveDepth(cfg, pr({ labels: ['fast'] }), 'risky', [])).toEqual({
			depth: 'quick',
			source: 'label fast',
		})
		expect(
			resolveDepth(cfg, pr({ labels: ['thorough'] }), 'trivial', [])
		).toEqual({ depth: 'deep', source: 'label thorough' })
		expect(
			resolveDepth(
				cfg,
				pr({ labels: [DEFAULT_PRESET.labels.depth.deep] }),
				'normal',
				[]
			)
		).toEqual({ depth: DEPTH_FOR_RISK.normal, source: 'risk normal' })
	})
})

describe('command depth', () => {
	test('takes precedence over risk paths, labels, config and router risk', () => {
		const cfg = config({ depth: 'quick' })
		expect(
			resolveDepth(
				cfg,
				pr({ depth: 'deep', labels: [cfg.labels.depth.quick] }),
				'trivial',
				['src/risk.ts']
			)
		).toEqual({ depth: 'deep', source: 'command' })
	})
	test('does not create a label when choosing command depth', () => {
		const info = pr({ depth: 'deep' })
		expect(resolveDepth(config(), info, 'normal', [])).toEqual({
			depth: 'deep',
			source: 'command',
		})
		expect(info.labels).toEqual([])
	})
})

describe('requested quick depth', () => {
	test('wins over a deep label, review.yml and risky paths', () => {
		const cfg = config({ depth: 'deep' })
		const info = pr({ depth: 'quick', labels: [cfg.labels.depth.deep] })
		expect(
			resolveDepth(cfg, info, 'risky', ['src/billing/invoice.ts'])
		).toEqual({ depth: 'quick', source: 'command' })
		expect(info.labels).toEqual([cfg.labels.depth.deep])
	})
})
