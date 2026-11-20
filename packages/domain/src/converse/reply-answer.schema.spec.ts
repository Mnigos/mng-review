import { Schema } from 'effect'
import { replyAnswerSchema } from './reply-answer.schema'
import { REPLY_CLAIMS, REPLY_REASON_MAX_CHARS } from './reply.constants'

const decode = Schema.decodeUnknownSync(replyAnswerSchema)

describe('replyAnswerSchema', () => {
	test.each(REPLY_CLAIMS)('reads trimmed mixed-case %s', claim => {
		expect(decode({ claim: `  ${claim.toUpperCase()}  ` })).toEqual({
			claim,
			holds: false,
			evidence: [],
		})
	})
	test.each([undefined, null])(
		'intentional with holds %s does not hold',
		holds => {
			expect(
				decode({
					claim: 'intentional',
					...(holds === undefined ? {} : { holds }),
				}).holds
			).toBe(false)
		}
	)
	test('preserves an explicit holding reason and evidence', () => {
		expect(
			decode({
				claim: 'intentional',
				holds: true,
				reason: '  Uses cents.  ',
				failed_premise: null,
				evidence: [' src/money.ts:2-4 cents '],
			})
		).toEqual({
			claim: 'intentional',
			holds: true,
			reason: 'Uses cents.',
			failed_premise: null,
			evidence: ['src/money.ts:2-4 cents'],
		})
	})
	test('rejects an unknown claim', () => {
		expect(() => decode({ claim: 'approved' })).toThrow()
	})
	test.each(['src/money.ts', 'line 2', ':2', 'src/money.ts:two'])(
		'rejects malformed evidence %s',
		evidence => {
			expect(() =>
				decode({ claim: 'intentional', evidence: [evidence] })
			).toThrow()
		}
	)
})

describe('reply answer text bounds', () => {
	test.each(['reason', 'failed_premise'] as const)(
		'decodes a long %s to at most 300 characters with an ellipsis',
		field => {
			const text = 'x'.repeat(REPLY_REASON_MAX_CHARS + 80)
			expect(
				decode({ claim: 'intentional', [field]: `  ${text}\n tail ` })[field]
			).toBe(`${'x'.repeat(REPLY_REASON_MAX_CHARS - 1)}…`)
		}
	)
	test('normalizes internal whitespace in both optional sentences', () => {
		expect(
			decode({
				claim: 'intentional',
				reason: '  Integer\ncents.\tStable. ',
				failed_premise: ' Dollars\r\n differ. ',
			})
		).toMatchObject({
			reason: 'Integer cents. Stable.',
			failed_premise: 'Dollars differ.',
		})
	})
})
