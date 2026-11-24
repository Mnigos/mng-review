import { layer } from '@effect/vitest'
import { toCutLine } from '@mng-review/domain'
import { Effect, Layer, Result } from 'effect'
import { RISK_ANSWER } from '../../../shared/mocks/risk-test.helper'
import {
	MAX_RISK_DIRECTION_CHARS,
	MAX_RISK_REASON_CHARS,
	MAX_RISK_REASONS,
	MAX_RISK_REF_CHARS,
	MAX_RISK_REFS,
} from '../domain/rater.constants'
import { parseRiskAnswer } from './risk-answer.parser'

layer(Layer.empty)('parseRiskAnswer', test => {
	test.effect(
		'keeps the first three nonblank reasons and cuts a long reason with an ellipsis',
		() =>
			Effect.gen(function* () {
				const long = 'x'.repeat(MAX_RISK_REASON_CHARS + 1)
				const parsed = yield* parseRiskAnswer({
					...RISK_ANSWER,
					reasons: [' ', long, 'second', 'third', 'fourth'],
				})
				expect(parsed.reasons).toEqual([
					toCutLine(long, MAX_RISK_REASON_CHARS),
					'second',
					'third',
				])
				expect(parsed.reasons).toHaveLength(MAX_RISK_REASONS)
				expect(parsed.reasons[0]).toHaveLength(MAX_RISK_REASON_CHARS)
				expect(parsed.reasons[0]?.endsWith('…')).toBeTruthy()
			})
	)
	test.effect(
		'cuts refs and directions to their limits and omits blank refs and directions',
		() =>
			Effect.gen(function* () {
				const refs = Array.from(
					{ length: MAX_RISK_REFS + 2 },
					(_, index) => `${index}${'x'.repeat(MAX_RISK_REF_CHARS)}`
				)
				const up = 'u'.repeat(MAX_RISK_DIRECTION_CHARS + 1)
				const down = 'd'.repeat(MAX_RISK_DIRECTION_CHARS + 1)
				expect(
					yield* parseRiskAnswer({
						...RISK_ANSWER,
						refs: [' ', ...refs],
						up,
						down,
					})
				).toEqual({
					...RISK_ANSWER,
					refs: refs
						.slice(0, MAX_RISK_REFS)
						.map(ref => toCutLine(ref, MAX_RISK_REF_CHARS)),
					up: toCutLine(up, MAX_RISK_DIRECTION_CHARS),
					down: toCutLine(down, MAX_RISK_DIRECTION_CHARS),
				})
				expect(
					yield* parseRiskAnswer({
						...RISK_ANSWER,
						refs: [' ', '\n'],
						up: ' ',
						down: '\n',
					})
				).toEqual(RISK_ANSWER)
			})
	)
	for (const malformed of [
		{ reasons: ['reason'], refs: [] },
		{ ...RISK_ANSWER, level: 'critical' },
		{ ...RISK_ANSWER, reasons: [' ', '\n'] },
		null,
		'low',
	])
		test.effect(`rejects ${JSON.stringify(malformed)}`, () =>
			Effect.gen(function* () {
				expect(
					Result.isFailure(yield* Effect.result(parseRiskAnswer(malformed)))
				).toBeTruthy()
			})
		)
})
