import { Schema } from 'effect'
import { replyAnswerSchema } from './reply-answer.schema'
import { REPLY_CLAIMS } from './reply.constants'

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
