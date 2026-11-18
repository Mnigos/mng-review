import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { rawFinding } from '../shared/mocks/domain-test.helper'
import { FindingsAnswerError } from './finding.errors'
import { parseFindingsAnswer } from './findings-answer.parser'

layer(Layer.empty)('parseFindingsAnswer', test => {
	test.effect(
		'drops malformed entries, counts them and normalizes relative paths',
		() =>
			Effect.gen(function* () {
				expect(
					yield* parseFindingsAnswer({
						findings: [
							rawFinding({ path: './src/billing/charge.ts' }),
							null,
							{ title: 'missing fields' },
							rawFinding({ path: '../outside.ts' }),
							rawFinding({ path: 'a/../../outside.ts' }),
							rawFinding({ path: 'src\\charge.ts' }),
							rawFinding({ path: 'bad\0path' }),
							rawFinding({ path: '.' }),
						],
					})
				).toEqual({ findings: [rawFinding()], dropped: 7 })
			})
	)
	test.effect('accepts a bare list or an empty findings envelope', () =>
		Effect.gen(function* () {
			expect(yield* parseFindingsAnswer([rawFinding()])).toEqual({
				findings: [rawFinding()],
				dropped: 0,
			})
			expect(yield* parseFindingsAnswer({ findings: [] })).toEqual({
				findings: [],
				dropped: 0,
			})
			expect(yield* parseFindingsAnswer([])).toEqual({
				findings: [],
				dropped: 0,
			})
		})
	)
	for (const input of [
		null,
		{},
		{ findings: null },
		{ findings: 'wrong' },
		undefined,
	])
		test.effect(`rejects malformed envelope ${JSON.stringify(input)}`, () =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(parseFindingsAnswer(input))
				expect(error).toBeInstanceOf(FindingsAnswerError)
				expect(error.message).toBe('expected an object with a "findings" array')
			})
		)
	for (const path of ['/etc/passwd', 'C:/x', 'c:x', '', 'a/..'])
		test.effect(
			`drops unsafe or root finding path ${JSON.stringify(path)}`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* parseFindingsAnswer({ findings: [rawFinding({ path })] })
					).toEqual({ findings: [], dropped: 1 })
				})
		)
})
