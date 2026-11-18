import { layer } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { rawFinding } from '../shared/mocks/domain-test.helper'
import { reportedFindingSchema } from './finding.schema'

layer(Layer.empty)('reportedFindingSchema', test => {
	test.effect(
		'normalizes severity case, coerces numeric line strings and trims text',
		() =>
			Effect.gen(function* () {
				expect(
					yield* Schema.decodeUnknownEffect(reportedFindingSchema)({
						...rawFinding(),
						severity: 'HiGh',
						line: '12',
						title: ' Problem ',
						trigger: '\nInput ',
						impact: ' Damage\t',
						evidence: [' file.ts:12 proof '],
						suggestion: ' Fix ',
					})
				).toMatchObject({
					severity: 'high',
					line: 12,
					title: 'Problem',
					trigger: 'Input',
					impact: 'Damage',
					evidence: ['file.ts:12 proof'],
					suggestion: 'Fix',
				})
			})
	)
	test.effect(
		'defaults evidence and accepts absent or null suggestions and line zero',
		() =>
			Effect.gen(function* () {
				const { evidence: _evidence, ...reported } = rawFinding()
				expect(
					yield* Schema.decodeUnknownEffect(reportedFindingSchema)({
						...reported,
						suggestion: null,
						line: 0,
					})
				).toEqual({ ...reported, evidence: [], suggestion: null, line: 0 })
				expect(
					yield* Schema.decodeUnknownEffect(reportedFindingSchema)(reported)
				).toEqual(rawFinding())
			})
	)

	for (const field of [
		'path',
		'line',
		'severity',
		'title',
		'trigger',
		'impact',
	] as const)
		test.effect(`rejects missing ${field}`, () =>
			Effect.gen(function* () {
				const { [field]: _missing, ...raw } = rawFinding()
				expect(
					(yield* Effect.flip(
						Schema.decodeUnknownEffect(reportedFindingSchema)(raw)
					))._tag
				).toBe('SchemaError')
			})
		)

	for (const fields of [
		{ line: -1 },
		{ line: 1.5 },
		{ line: '1.5' },
		{ line: 'not-a-number' },
		{ severity: 'urgent' },
		{ path: '' },
		{ title: ' ' },
		{ trigger: '' },
		{ impact: ' ' },
		{ evidence: [null] },
		{ evidence: [' '] },
		{ suggestion: ' ' },
	])
		test.effect(`rejects malformed fields ${JSON.stringify(fields)}`, () =>
			Effect.gen(function* () {
				expect(
					(yield* Effect.flip(
						Schema.decodeUnknownEffect(reportedFindingSchema)({
							...rawFinding(),
							...fields,
						})
					))._tag
				).toBe('SchemaError')
			})
		)
})
