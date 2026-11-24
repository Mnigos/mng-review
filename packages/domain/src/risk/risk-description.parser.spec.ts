import {
	parseRiskDescription,
	toRiskDescription,
} from './risk-description.parser'
import type { RiskDescription } from './risk-description.schema'
import { STATUS_LEVELS } from './risk.constants'

const DESCRIPTION = {
	pr: 42,
	level: 'low',
	floor: false,
	base: 'a'.repeat(40),
	rules: 'b'.repeat(12),
	nonce: 'c'.repeat(16),
} as const satisfies RiskDescription
const TEXT = toRiskDescription(DESCRIPTION)

describe('risk status descriptions', () => {
	test.each(STATUS_LEVELS)('round trips %s with both floor flags', level => {
		for (const floor of [false, true]) {
			const description = { ...DESCRIPTION, level, floor }
			expect(parseRiskDescription(toRiskDescription(description))).toEqual(
				description
			)
			expect(toRiskDescription(description)).toContain(
				`floor=${floor ? 'yes' : '-'}`
			)
		}
	})
	test('the longest permitted description has 121 characters and fits GitHub', () => {
		const text = toRiskDescription({
			...DESCRIPTION,
			pr: 9_999_999_999,
			level: 'medium',
			floor: true,
		})
		expect(text).toHaveLength(121)
		expect(text.length).toBeLessThanOrEqual(140)
		expect(parseRiskDescription(text)?.pr).toBe(9_999_999_999)
	})
	test.each([
		'',
		` ${TEXT}`,
		`${TEXT} `,
		`${TEXT}\t`,
		`${TEXT}\nextra`,
		TEXT.replace('v1', 'v2'),
		TEXT.replace('pr=42', 'pr=042'),
		TEXT.replace('pr=42', 'pr=0'),
		TEXT.replace('pr=42', 'pr=-1'),
		TEXT.replace('pr=42', 'pr=1.5'),
		TEXT.replace('pr=42', 'pr=10000000000'),
		TEXT.replace('pr=42', 'pr='),
		TEXT.replace('low', 'LOW'),
		TEXT.replace('low', 'critical'),
		TEXT.replace('floor=-', 'floor=no'),
		TEXT.replace('floor=-', 'floor=true'),
		TEXT.replace('floor=-', 'floor=YES'),
		TEXT.replace(' base=', '  base='),
		TEXT.replace('base=', 'BASE='),
		TEXT.replace('a'.repeat(40), 'a'.repeat(39)),
		TEXT.replace('a'.repeat(40), 'a'.repeat(41)),
		TEXT.replace('a'.repeat(40), 'A'.repeat(40)),
		TEXT.replace('a'.repeat(40), 'g'.repeat(40)),
		TEXT.replace('b'.repeat(12), 'b'.repeat(11)),
		TEXT.replace('b'.repeat(12), 'b'.repeat(13)),
		TEXT.replace('b'.repeat(12), 'B'.repeat(12)),
		TEXT.replace('c'.repeat(16), 'c'.repeat(15)),
		TEXT.replace('c'.repeat(16), 'c'.repeat(17)),
		TEXT.replace('c'.repeat(16), 'C'.repeat(16)),
		TEXT.replace(/ nonce=.*$/u, ''),
		`${TEXT} extra=value`,
	])('rejects malformed description %j', text => {
		expect(parseRiskDescription(text)).toBeUndefined()
	})
	test.each(['\n', '\r', '\r\n'])(
		'rejects a trailing line ending %j',
		suffix => {
			expect(parseRiskDescription(`${TEXT}${suffix}`)).toBeUndefined()
		}
	)
})
