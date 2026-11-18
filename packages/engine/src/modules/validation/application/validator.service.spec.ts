import { layer } from '@effect/vitest'
import { Effect, Layer, Ref } from 'effect'
import { LanguageModel } from 'effect/ai'
import {
	RulesService,
	RulesServiceLive,
} from '../../../platform/config/rules.service'
import { GitService } from '../../../platform/git/git.service'
import {
	ScriptedLlm,
	type ScriptedLlmAnswer,
} from '../../../platform/llm/scripted-llm.layer'
import { TokenLedger } from '../../../platform/llm/token-ledger.service'
import { config, finding } from '../../../shared/mocks/domain-test.helper'
import {
	cleanupRepos,
	createRepo,
	FileSystemLayer,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import {
	providerError,
	reviewDependencies,
	userText,
} from '../../../shared/mocks/review-layer.helper'
import {
	answer,
	BILLING_PATH,
	finishWithUsage,
	MODEL,
	REVIEWERS,
	reviewRequest,
	SCOPE,
	verdict,
} from '../../../shared/mocks/review-test.helper'
import { AgentLoopService } from '../../review/application/services/agent-loop.service'
import { ModelHealthService } from '../../review/application/services/model-health.service'
import { RepoToolsService } from '../../review/application/services/repo-tools.service'
import { TokenBudgetError } from '../../review/domain/review.errors'
import { ValidatorService, ValidatorServiceLive } from './validator.service'

const CONTEXT = {
	scope: SCOPE,
	config: config({ models: { reviewer: REVIEWERS, validator: 'cross' } }),
	rules: reviewRequest().rules,
} as const

/** Uses the actual parser and loop so schema corrections are observable provider turns. */
function validatorLayer(
	script: ScriptedLlmAnswer,
	limits: Parameters<typeof reviewDependencies>[1] = {}
) {
	return ValidatorServiceLive.pipe(
		Layer.provideMerge(reviewDependencies(script, limits))
	)
}

layer(Layer.empty)('ValidatorService', test => {
	for (const dropModel of [false, true])
		test.effect(
			`TokenBudgetError ends after one attempt when model drop is ${dropModel}`,
			() =>
				Effect.gen(function* () {
					const attempts = yield* Ref.make(0)
					const loopLayer = Layer.effect(
						AgentLoopService,
						Effect.gen(function* () {
							const health = yield* ModelHealthService
							return {
								run: () =>
									Effect.gen(function* () {
										yield* Ref.update(attempts, value => value + 1)
										if (dropModel)
											yield* health
												.run(
													REVIEWERS[1],
													LanguageModel.generateText({
														prompt: 'Fixture model drop.',
													})
												)
												.pipe(Effect.ignore)
										return yield* new TokenBudgetError({
											spent: 100,
											limit: 100,
										})
									}),
							}
						})
					)
					yield* Effect.gen(function* () {
						expect(
							yield* ValidatorService.use(validator =>
								validator.validate(finding(), CONTEXT)
							)
						).toMatchObject({
							status: 'unvalidated',
							budgetSpent: true,
							error: 'token budget spent: 100 of limits.tokens_per_run 100',
						})
						expect(yield* Ref.get(attempts)).toBe(1)
						expect(
							yield* ModelHealthService.use(health => health.dropped)
						).toHaveLength(dropModel ? 1 : 0)
						expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(
							dropModel ? 1 : 0
						)
					}).pipe(
						Effect.provide(
							ValidatorServiceLive.pipe(
								Layer.provide(loopLayer),
								Layer.provideMerge(
									reviewDependencies(() => Effect.fail(providerError(503)))
								)
							)
						)
					)
				})
		)

	for (const stage of ['before', 'during'] as const)
		test.effect(
			`budget spent ${stage} validation keeps it unvalidated and starts no further model call`,
			() =>
				Effect.gen(function* () {
					if (stage === 'before')
						yield* ModelHealthService.use(health =>
							health.run(
								MODEL,
								LanguageModel.generateText({
									prompt: 'Spend the fixture budget.',
								})
							)
						)
					expect(
						yield* ValidatorService.use(validator =>
							validator.validate(finding(), CONTEXT)
						)
					).toMatchObject({
						status: 'unvalidated',
						budgetSpent: true,
						error: expect.stringContaining('token budget spent') as unknown,
					})
					expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(1)
				}).pipe(
					Effect.provide(
						validatorLayer(
							() =>
								Effect.succeed(
									stage === 'before'
										? [finishWithUsage(100)]
										: [
												{ type: 'text', text: 'not a verdict' },
												finishWithUsage(100),
											]
								),
							{ tokensPerRun: 100 }
						)
					)
				)
		)
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
		'a dropped last model ends the attempts and keeps its drop as the error',
		() =>
			Effect.gen(function* () {
				const cfg = config({
					models: { reviewer: [REVIEWERS[0]], validator: 'cross' },
				})
				expect(
					yield* ValidatorService.use(validator =>
						validator.validate(finding(), { ...CONTEXT, config: cfg })
					)
				).toMatchObject({
					status: 'unvalidated',
					error: expect.stringContaining('unavailable (503)') as unknown,
				})
				expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(1)
			}).pipe(
				Effect.provide(validatorLayer(() => Effect.fail(providerError(503))))
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

	for (const all of [false, true])
		test.effect(
			all
				? 'no available validator returns unvalidated without a model call'
				: 'already dropped validator is skipped before the first attempt',
			() =>
				Effect.gen(function* () {
					const health = yield* ModelHealthService
					yield* health
						.run(
							REVIEWERS[1],
							LanguageModel.generateText({
								prompt: 'Probe fixture availability.',
							})
						)
						.pipe(Effect.flip)
					if (all)
						yield* health
							.run(
								REVIEWERS[0],
								LanguageModel.generateText({
									prompt: 'Probe fixture availability.',
								})
							)
							.pipe(Effect.flip)
					const before = yield* ScriptedLlm.use(script => script.calls)
					expect(
						yield* ValidatorService.use(validator =>
							validator.validate(finding(), CONTEXT)
						)
					).toMatchObject(
						all
							? { status: 'unvalidated', error: 'no validator model left' }
							: { status: 'confirmed', model: 'model-a' }
					)
					const calls = (yield* ScriptedLlm.use(script => script.calls)).slice(
						before.length
					)
					expect(calls.map(call => call.model.model)).toEqual(
						all ? [] : ['model-a']
					)
				}).pipe(
					Effect.provide(
						validatorLayer(call =>
							userText(call) === 'Probe fixture availability.'
								? Effect.fail(providerError(503))
								: Effect.succeed(answer('report_verdict', verdict()))
						)
					)
				)
		)
})

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })(
	'ValidatorService committed inputs',
	test => {
		test.effect(
			'user message includes the finding, committed head file, diff and uppercase notes',
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					repo.write(BILLING_PATH, 'export const charge = 1\n')
					repo.write('.mng/CONTEXT.md', CONTEXT.rules.context)
					repo.write('.mng/MEMORY.md', CONTEXT.rules.memory)
					repo.commit()
					repo.git('checkout', '-b', 'feature')
					repo.write(BILLING_PATH, 'export const balance = 9\n')
					repo.commit()
					repo.write(BILLING_PATH, 'uncommitted replacement must not appear')
					const git = yield* GitService.pipe(
						Effect.provide(gitLayer(repo.root))
					)
					const change = yield* git.readChange('main', 'HEAD')
					const rules = yield* RulesService.use(service =>
						service.load('HEAD')
					).pipe(
						Effect.provide(
							RulesServiceLive.pipe(
								Layer.provide(gitLayer(repo.root)),
								Layer.provide(FileSystemLayer)
							)
						)
					)
					const original = finding({
						suggestion: 'Deduplicate by invoice key.',
						evidence: [`${BILLING_PATH}:2 charge`],
					})
					yield* Effect.gen(function* () {
						expect(
							yield* ValidatorService.use(validator =>
								validator.validate(original, {
									...CONTEXT,
									scope: { ...SCOPE, change },
									rules,
								})
							)
						).toMatchObject({ status: 'confirmed' })
						const calls = yield* ScriptedLlm.use(script => script.calls)
						const user = userText(calls[0])
						for (const value of [
							original.title,
							original.trigger,
							original.impact,
							'Deduplicate by invoice key.',
							`${BILLING_PATH}:2 charge`,
							'1| export const balance = 9',
							'-export const charge = 1\n+export const balance = 9',
							'.mng/CONTEXT.md',
							CONTEXT.rules.context,
							'.mng/MEMORY.md',
							CONTEXT.rules.memory,
						])
							expect(user).toContain(value)
						expect(user).not.toContain(
							'uncommitted replacement must not appear'
						)
						expect(user).not.toContain('.mng/context.md')
						expect(user).not.toContain('.mng/memory.md')
					}).pipe(
						Effect.provide(
							ValidatorServiceLive.pipe(
								Layer.provideMerge(
									reviewDependencies(
										() => Effect.succeed(answer('report_verdict', verdict())),
										{},
										git
									)
								)
							)
						)
					)
				})
		)
	}
)

layer(Layer.empty)('validator first-message context', test => {
	for (const [line, range] of [
		[2, '1-152'],
		[500, '350-650'],
	] as const)
		test.effect(
			`reads finding line ${line} at head with range ${range} and caps the file at 20k characters`,
			() =>
				Effect.gen(function* () {
					const callSpy = vi.fn<RepoToolsService['Service']['call']>(
						(_scope, name) =>
							Effect.succeed(
								name === 'read_file'
									? `${'x'.repeat(20_000)}TAIL_OUTSIDE_CAP`
									: 'fixture diff'
							)
					)
					yield* Effect.gen(function* () {
						yield* ValidatorService.use(validator =>
							validator.validate(finding({ line }), {
								...CONTEXT,
								budget: { runTokens: 1000, conversationTokens: 1 },
							})
						)
						expect(callSpy).toHaveBeenCalledWith(SCOPE, 'read_file', {
							ref: 'head',
							path: BILLING_PATH,
							range,
						})
						const calls = yield* ScriptedLlm.use(script => script.calls)
						const message = userText(calls[0])
						const fileText =
							message
								.split(
									'lines around the finding (read more with read_file):\n```text\n'
								)[1]
								?.split('\n```')[0] ?? ''
						expect(fileText.length).toBeGreaterThan(0)
						expect(fileText.length).toBeLessThanOrEqual(20_000)
						expect(message).not.toContain('TAIL_OUTSIDE_CAP')
						expect(
							calls[0]?.options.tools.map(tool => String(tool.name))
						).toEqual(['report_verdict'])
						expect(
							yield* TokenLedger.use(ledger => ledger.sources)
						).toMatchObject({ validator: { calls: 1, conversations: 1 } })
					}).pipe(
						Effect.provide(
							ValidatorServiceLive.pipe(
								Layer.provide(
									Layer.succeed(RepoToolsService, { call: callSpy })
								),
								Layer.provideMerge(
									reviewDependencies(() =>
										Effect.succeed(answer('report_verdict', verdict()))
									)
								)
							)
						)
					)
				})
		)
})
