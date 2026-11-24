import { rawFinding } from '../shared/mocks/domain-test.helper'
import { toWithinTextLimits } from './finding-text.helper'
import {
	MAX_FINDING_FIX_CHARS,
	MAX_FINDING_IMPACT_CHARS,
	MAX_FINDING_STEP_CHARS,
	MAX_FINDING_TITLE_CHARS,
} from './finding.constants'

const LONG = 'word '.repeat(200).trim()
const LINE_SEPARATOR = String.fromCodePoint(0x20_28)

describe('toWithinTextLimits', () => {
	test('keeps a finding within the limits as it is', () => {
		expect(toWithinTextLimits(rawFinding())).toEqual(rawFinding())
	})
	test.each([
		['title', MAX_FINDING_TITLE_CHARS],
		['impact', MAX_FINDING_IMPACT_CHARS],
		['suggestion', MAX_FINDING_FIX_CHARS],
	] as const)('cuts %s to its limit at a word boundary', (field, max) => {
		const cut = toWithinTextLimits(rawFinding({ [field]: LONG }))[field]
		expect(cut?.length).toBeLessThanOrEqual(max)
		expect(cut).toMatch(/^word( word)*…$/u)
	})
	test('cuts each trigger step on its own and keeps every step', () => {
		const steps = ['1. short', LONG, LONG].join('\r\n')
		const { trigger } = toWithinTextLimits(rawFinding({ trigger: steps }))
		const lines = trigger.split('\n')
		expect(lines).toHaveLength(3)
		expect(lines[0]).toBe('1. short')
		for (const line of lines.slice(1)) {
			expect(line.length).toBeLessThanOrEqual(MAX_FINDING_STEP_CHARS)
			expect(line).toMatch(/word…$/u)
		}
	})
	test('puts the title and the fix on one line', () => {
		expect(
			toWithinTextLimits(
				rawFinding({
					title: 'first\n\nlast',
					suggestion: `a${LINE_SEPARATOR}b`,
				})
			)
		).toMatchObject({ title: 'first last', suggestion: 'a b' })
	})
	test.each([null, undefined])('keeps suggestion %j', suggestion => {
		const finding =
			suggestion === undefined ? rawFinding() : rawFinding({ suggestion })
		expect(toWithinTextLimits(finding)).toEqual(finding)
	})
})
