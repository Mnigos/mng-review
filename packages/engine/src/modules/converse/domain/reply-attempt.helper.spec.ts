import { layer } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'
import { finding } from '../../../shared/mocks/domain-test.helper'
import {
	isFinal,
	parseReplyAnswer,
	toCauseMessage,
	toFileWindow,
	toReportedFinding,
} from './reply-attempt.helper'
import { FILE_WINDOW_LINES, NO_MODEL_LEFT } from './reply.constants'

describe('reply attempt helpers', () => {
	test.each([0, 1, FILE_WINDOW_LINES, FILE_WINDOW_LINES + 20])(
		'bounds the file window around line %s',
		line => {
			expect(toFileWindow(line)).toBe(
				`${Math.max(1, line - FILE_WINDOW_LINES)}-${line + FILE_WINDOW_LINES}`
			)
		}
	)
	test('reports only the finding fields the classifier needs', () => {
		const entry = finding({ suggestion: 'Use the safe path.' })
		expect(toReportedFinding(entry)).toEqual({
			path: entry.path,
			line: entry.line,
			severity: entry.severity,
			title: entry.title,
			trigger: entry.trigger,
			impact: entry.impact,
			evidence: entry.evidence,
		})
		expect(toReportedFinding(entry)).not.toHaveProperty('suggestion')
	})
	test.each([
		[{ message: NO_MODEL_LEFT }, true],
		[{ _tag: 'TokenBudgetError', message: 'spent' }, true],
		[{ _tag: 'LoopError', message: 'bad answer' }, false],
		[{ message: 'temporary provider failure' }, false],
	] as const)('only final failures stop retries: %j', (error, expected) => {
		expect(isFinal(error)).toBe(expected)
	})
})

layer(Layer.empty)('reply attempt effects', test => {
	test.effect(
		'parses the answer boundary and maps the failed premise to the domain claim',
		() =>
			Effect.gen(function* () {
				expect(
					yield* parseReplyAnswer({
						claim: ' INTENTIONAL ',
						holds: false,
						reason: ' A reason. ',
						failed_premise: ' Units differ. ',
						evidence: ['src/policy.ts:2 policy'],
					})
				).toEqual({
					claim: 'intentional',
					holds: false,
					reason: 'A reason.',
					failedPremise: 'Units differ.',
					evidence: ['src/policy.ts:2 policy'],
				})
			})
	)
	test.effect(
		'invalid model answers return a problem for the correction turn',
		() =>
			Effect.gen(function* () {
				expect(
					yield* Effect.flip(parseReplyAnswer({ claim: 'approved' }))
				).toEqual({ message: expect.stringContaining('claim') as unknown })
			})
	)
	for (const failure of ['typed', 'error defect', 'string defect'] as const)
		test.effect(`extracts a readable message from a ${failure}`, () =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(
					failure === 'typed'
						? Effect.fail({ message: 'fixture failure' })
						: Effect.die(
								failure === 'error defect'
									? new Error('fixture failure')
									: 'fixture failure'
							)
				)
				expect(Exit.isFailure(exit)).toBe(true)
				if (Exit.isFailure(exit))
					expect(toCauseMessage(exit.cause)).toBe('fixture failure')
			})
		)
})
