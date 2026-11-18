import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
	ScriptedLlm,
	type ScriptedLlmAnswer,
} from '../../../platform/llm/scripted-llm.layer'
import { config, finding } from '../../../shared/mocks/domain-test.helper'
import {
	providerError,
	reviewDependencies,
	userText,
} from '../../../shared/mocks/review-layer.helper'
import {
	answer,
	BILLING_PATH,
	REVIEWERS,
	reviewRequest,
	SCOPE,
	verdict,
} from '../../../shared/mocks/review-test.helper'
import { ValidatorService, ValidatorServiceLive } from './validator.service'

const CONTEXT = {
	scope: SCOPE,
	config: config({ models: { reviewer: REVIEWERS, validator: 'cross' } }),
	rules: reviewRequest().rules,
} as const

/** Uses the actual parser and loop so schema corrections are observable provider turns. */
function validatorLayer(script: ScriptedLlmAnswer) {
	return ValidatorServiceLive.pipe(
		Layer.provideMerge(reviewDependencies(script))
	)
}

layer(Layer.empty)('ValidatorService', test => {
	test.effect(
		'confirms a re-rated severity on the other reviewer model with fenced source and notes',
		() =>
			Effect.gen(function* () {
				expect(
					yield* ValidatorService.use(validator =>
						validator.validate(
							finding({ suggestion: 'Deduplicate by key.' }),
							CONTEXT
						)
					)
				).toEqual({
					status: 'confirmed',
					model: 'model-b',
					severity: 'high',
					reason: verdict().reason,
					evidence: verdict().evidence,
				})
				const calls = yield* ScriptedLlm.use(script => script.calls)
				expect(calls[0]?.model.model).toBe('model-b')
				expect(
					calls[0]?.options.tools.map(tool => String(tool.name))
				).not.toContain('pr_metadata')
				for (const text of [
					'The finding to check:\n```text\n{',
					'Deduplicate by key.',
					BILLING_PATH,
					'1| const balance = 9',
					'Diff of',
					'.mng/CONTEXT.md',
					CONTEXT.rules.context,
					'.mng/MEMORY.md',
					CONTEXT.rules.memory,
				])
					expect(userText(calls[0])).toContain(text)
			}).pipe(
				Effect.provide(
					validatorLayer(() =>
						Effect.succeed(
							answer('report_verdict', verdict({ severity: 'HIGH' }))
						)
					)
				)
			)
	)
	test.effect(
		'rejection retains the reason and model and permits empty evidence',
		() =>
			Effect.gen(function* () {
				expect(
					yield* ValidatorService.use(validator =>
						validator.validate(finding(), CONTEXT)
					)
				).toMatchObject({
					status: 'rejected',
					model: 'model-b',
					reason: 'Caller deduplicates.',
					evidence: [],
				})
			}).pipe(
				Effect.provide(
					validatorLayer(() =>
						Effect.succeed(
							answer(
								'report_verdict',
								verdict({
									verdict: 'reject',
									reason: 'Caller deduplicates.',
									evidence: [],
								})
							)
						)
					)
				)
			)
	)
	for (const evidence of [
		[],
		['no source location'],
		[`${BILLING_PATH}:abc invalid`],
		[`${BILLING_PATH}:2suffix invalid`],
	])
		test.effect(
			`invalid confirmation evidence ${JSON.stringify(evidence)} gets a correction`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* ValidatorService.use(validator =>
							validator.validate(finding(), CONTEXT)
						)
					).toMatchObject({ status: 'confirmed' })
					const calls = yield* ScriptedLlm.use(script => script.calls)
					expect(calls).toHaveLength(2)
					expect(calls[1]?.options.prompt.content.at(-1)).toMatchObject({
						role: 'tool',
						content: [
							expect.objectContaining({
								result: expect.stringContaining('path:line') as unknown,
							}) as unknown,
						],
					})
				}).pipe(
					Effect.provide(
						validatorLayer((_call, index) =>
							Effect.succeed(
								answer(
									'report_verdict',
									verdict(index === 0 ? { evidence } : {})
								)
							)
						)
					)
				)
		)
	for (const evidence of [
		`${BILLING_PATH}:2`,
		`${BILLING_PATH}:2-4 balance update`,
	])
		test.effect(`accepts evidence ${evidence}`, () =>
			Effect.gen(function* () {
				expect(
					yield* ValidatorService.use(validator =>
						validator.validate(finding(), CONTEXT)
					)
				).toMatchObject({ status: 'confirmed', evidence: [evidence] })
			}).pipe(
				Effect.provide(
					validatorLayer(() =>
						Effect.succeed(
							answer('report_verdict', verdict({ evidence: [evidence] }))
						)
					)
				)
			)
		)
	test.effect('a failed attempt retries in a fresh conversation', () =>
		Effect.gen(function* () {
			expect(
				yield* ValidatorService.use(validator =>
					validator.validate(finding(), CONTEXT)
				)
			).toMatchObject({ status: 'confirmed', model: 'model-b' })
			const calls = yield* ScriptedLlm.use(script => script.calls)
			expect(calls).toHaveLength(2)
			expect(calls[1]?.options.prompt).toEqual(calls[0]?.options.prompt)
			expect(calls[1]?.options.prompt.content).toHaveLength(2)
		}).pipe(
			Effect.provide(
				validatorLayer((_call, index) =>
					index === 0
						? Effect.fail(providerError(500))
						: Effect.succeed(answer('report_verdict', verdict()))
				)
			)
		)
	)
	test.effect(
		'two failed attempts keep the finding unvalidated with the last error',
		() =>
			Effect.gen(function* () {
				expect(
					yield* ValidatorService.use(validator =>
						validator.validate(finding(), CONTEXT)
					)
				).toMatchObject({
					status: 'unvalidated',
					error: expect.stringContaining('attempt 2') as unknown,
				})
				expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(2)
			}).pipe(
				Effect.provide(
					validatorLayer((_call, index) =>
						Effect.fail(providerError(500, `attempt ${index + 1}`))
					)
				)
			)
	)
	test.effect(
		'dropped validator moves to the next available model in a fresh conversation',
		() =>
			Effect.gen(function* () {
				expect(
					yield* ValidatorService.use(validator =>
						validator.validate(finding(), CONTEXT)
					)
				).toMatchObject({ status: 'confirmed', model: 'model-a' })
				const calls = yield* ScriptedLlm.use(script => script.calls)
				expect(calls.map(call => call.model.model)).toEqual([
					'model-b',
					'model-a',
				])
				expect(calls[1]?.options.prompt).toEqual(calls[0]?.options.prompt)
			}).pipe(
				Effect.provide(
					validatorLayer((_call, index) =>
						index === 0
							? Effect.fail(providerError(503))
							: Effect.succeed(answer('report_verdict', verdict()))
					)
				)
			)
	)
	test.effect('explicit validator comes before both reviewer models', () =>
		Effect.gen(function* () {
			const cfg = config({
				models: {
					reviewer: REVIEWERS,
					validator: { model: 'validator', effort: 'low' },
				},
			})
			expect(
				yield* ValidatorService.use(validator =>
					validator.validate(finding(), { ...CONTEXT, config: cfg })
				)
			).toMatchObject({ model: 'validator', status: 'confirmed' })
			expect(
				(yield* ScriptedLlm.use(script => script.calls))[0]?.model
			).toEqual({ model: 'validator', effort: 'low' })
		}).pipe(
			Effect.provide(
				validatorLayer(() =>
					Effect.succeed(answer('report_verdict', verdict()))
				)
			)
		)
	)
})
