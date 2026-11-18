import { DEFAULT_PRESET } from '../../config/review-config.constants'
import { config, pr } from '../../shared/mocks/domain-test.helper'
import { gateRun, isFeatureActive, getMatchingLabel } from './run-gate.helper'

describe('whole-run gate', () => {
	test.each([
		[pr({ fork: true }), 'skip.forks'],
		[pr({ draft: true }), 'skip.drafts'],
		...DEFAULT_PRESET.skip.authors.map(
			author => [pr({ author }), 'skip.authors'] as const
		),
		[pr({ labels: DEFAULT_PRESET.skip.labels }), 'skip.labels'],
		[pr({ target: 'release' }), 'skip.targets'],
	] as const)('gates %p', (info, reason) => {
		expect(gateRun(config({ skip: { targets: ['release'] } }), info)).toContain(
			reason
		)
	})
	test('allows ordinary PRs and disabled fork/draft checks', () => {
		expect(gateRun(config(), pr())).toBeUndefined()
		expect(
			gateRun(
				config({ skip: { forks: false, drafts: false } }),
				pr({ fork: true, draft: true })
			)
		).toBeUndefined()
		expect(
			gateRun(config(), pr({ author: undefined, target: undefined }))
		).toBeUndefined()
	})
	test('always_review overrides draft and skip.labels together', () => {
		expect(
			gateRun(
				config(),
				pr({
					draft: true,
					labels: [
						...DEFAULT_PRESET.skip.labels,
						...DEFAULT_PRESET.labels.always_review,
					],
				})
			)
		).toBeUndefined()
	})
	test.each([
		[
			pr({ fork: true, labels: DEFAULT_PRESET.labels.always_review }),
			'skip.forks',
		],
		[
			pr({
				author: DEFAULT_PRESET.skip.authors[0],
				labels: DEFAULT_PRESET.labels.always_review,
			}),
			'skip.authors',
		],
		[
			pr({ target: 'release', labels: DEFAULT_PRESET.labels.always_review }),
			'skip.targets',
		],
	] as const)('always_review cannot override %p', (info, reason) => {
		expect(gateRun(config({ skip: { targets: ['release'] } }), info)).toContain(
			reason
		)
	})
})

describe('feature modes', () => {
	for (const trigger of ['auto', 'manual'] as const)
		for (const forced of [false, true])
			test(`${trigger} trigger, always_review=${forced}`, () => {
				const info = pr({
					trigger,
					labels: forced ? DEFAULT_PRESET.labels.always_review : [],
				})
				expect(isFeatureActive('always', config(), info)).toBeTruthy()
				expect(isFeatureActive('off', config(), info)).toBe(false)
				expect(isFeatureActive('manual', config(), info)).toBe(
					trigger === 'manual' || forced
				)
			})
})

test('returns the first matching PR label, rather than the configured order', () => {
	expect(
		getMatchingLabel(pr({ labels: ['other', 'second', 'first'] }), [
			'first',
			'second',
		])
	).toBe('second')
	expect(getMatchingLabel(pr(), ['first'])).toBeUndefined()
	expect(getMatchingLabel(pr({ labels: ['first'] }), [])).toBeUndefined()
})
