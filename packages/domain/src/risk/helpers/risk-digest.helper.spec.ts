import { DEFAULT_PRESET } from '../../config/review-config.constants'
import type { RiskConfig } from '../../config/review-config.schema'
import { DIGEST_FIXTURES } from '../risk-fixtures.constants'
import { RULES_DIGEST_LENGTH } from '../risk.constants'
import { toAnswerDigest, toRulesDigest } from './risk-digest.helper'

const RUBRIC = '# Risk\nRate the complete change.'

describe('risk digests', () => {
	test.each(DIGEST_FIXTURES)('answer digest: $name', ({ body, digest }) => {
		expect(toAnswerDigest(body)).toBe(digest)
	})
	test('rules digest is a stable 12-character lowercase hex prefix', () => {
		const digest = toRulesDigest(RUBRIC, DEFAULT_PRESET.risk)
		expect(digest).toHaveLength(RULES_DIGEST_LENGTH)
		expect(digest).toMatch(/^[0-9a-f]{12}$/u)
		expect(toRulesDigest(RUBRIC, DEFAULT_PRESET.risk)).toBe(digest)
	})
	test('sorts risk keys and nested label and floor keys', () => {
		const floor = {
			name: 'critical',
			paths: ['src/**'],
			exclude: [],
			level: 'high',
		} as const
		const risk = { ...DEFAULT_PRESET.risk, floors: [floor] }
		expect(
			toRulesDigest(RUBRIC, {
				reviews_per_head: risk.reviews_per_head,
				assets: risk.assets,
				floors: [
					{
						level: floor.level,
						exclude: floor.exclude,
						paths: floor.paths,
						name: floor.name,
					},
				],
				labels: {
					high: risk.labels.high,
					medium: risk.labels.medium,
					low: risk.labels.low,
				},
				enabled: risk.enabled,
			})
		).toBe(toRulesDigest(RUBRIC, risk))
	})
	test.each([
		['enabled', { enabled: true }],
		[
			'low label',
			{ labels: { ...DEFAULT_PRESET.risk.labels, low: 'Small Risk' } },
		],
		[
			'medium label',
			{ labels: { ...DEFAULT_PRESET.risk.labels, medium: 'Moderate Risk' } },
		],
		[
			'high label',
			{ labels: { ...DEFAULT_PRESET.risk.labels, high: 'Large Risk' } },
		],
		[
			'floors',
			{
				floors: [
					{ name: 'critical', paths: ['src/**'], exclude: [], level: 'high' },
				],
			},
		],
		['assets', { assets: [] }],
		[
			'reviews_per_head',
			{ reviews_per_head: DEFAULT_PRESET.risk.reviews_per_head + 1 },
		],
	] satisfies readonly (readonly [string, Partial<RiskConfig>])[])(
		'changes with risk %s',
		(_name, override) => {
			expect(
				toRulesDigest(RUBRIC, { ...DEFAULT_PRESET.risk, ...override })
			).not.toBe(toRulesDigest(RUBRIC, DEFAULT_PRESET.risk))
		}
	)
	test('changes with the rubric or resolved import text', () => {
		expect(
			toRulesDigest(`${RUBRIC}\nImported policy.`, DEFAULT_PRESET.risk)
		).not.toBe(toRulesDigest(RUBRIC, DEFAULT_PRESET.risk))
	})
	test('ignores config outside risk', () => {
		const changed = {
			...DEFAULT_PRESET,
			depth: 'deep',
			comments: { ...DEFAULT_PRESET.comments, summary: false },
			risk_paths: ['src/**'],
		}
		expect(toRulesDigest(RUBRIC, changed.risk)).toBe(
			toRulesDigest(RUBRIC, DEFAULT_PRESET.risk)
		)
	})
})

test.each([
	['name', { name: 'other' }],
	['paths', { paths: ['lib/**'] }],
	['exclude', { exclude: ['src/generated/**'] }],
	['level', { level: 'medium' }],
] as const)('rules digest changes with floor %s', (_name, overrides) => {
	const floor = {
		name: 'critical',
		paths: ['src/**'],
		exclude: [],
		level: 'high',
	} as const
	expect(
		toRulesDigest(RUBRIC, {
			...DEFAULT_PRESET.risk,
			floors: [{ ...floor, ...overrides }],
		})
	).not.toBe(toRulesDigest(RUBRIC, { ...DEFAULT_PRESET.risk, floors: [floor] }))
})
