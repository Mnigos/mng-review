import { layer } from '@effect/vitest'
import { absorb, NEAR_LINES, UNNAMED_PREMISE } from '@mng-review/domain'
import { Deferred, Effect, Fiber, Layer, Ref } from 'effect'
import { LanguageModel } from 'effect/ai'
import {
	RulesService,
	RulesServiceLive,
} from '../../../platform/config/rules.service'
import { GitError } from '../../../platform/git/git.errors'
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
	gitFixture,
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
import { VALIDATOR_PROMPT } from './validator.prompt'
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
	test('validator instructions cover unverified answers and their premise', () => {
		expect(VALIDATOR_PROMPT).toContain('unverified')
		expect(VALIDATOR_PROMPT).toContain('premise')
	})
	test.effect(
		'keeps an unverified verdict with its premise and re-rated severity',
		() =>
			Effect.gen(function* () {
				const premise = 'Example Router passes a full URL to the callback.'
				expect(
					yield* ValidatorService.use(validator =>
						validator.validate(finding(), CONTEXT)
					)
				).toEqual({
					status: 'unverified',
					premise,
					severity: 'high',
					reason: verdict().reason,
					evidence: verdict().evidence,
					model: 'model-b',
				})
				const calls = yield* ScriptedLlm.use(script => script.calls)
				expect(calls).toHaveLength(1)
				expect(calls[0]?.options.prompt.content[0]).toMatchObject({
					role: 'system',
					content: expect.stringContaining(VALIDATOR_PROMPT) as unknown,
				})
			}).pipe(
				Effect.provide(
					validatorLayer(() =>
						Effect.succeed(
							answer(
								'report_verdict',
								verdict({
									verdict: 'unverified',
									severity: 'high',
									premise: 'Example Router passes a full URL to the callback.',
								})
							)
						)
					)
				)
			)
	)
	for (const premise of [undefined, '   '])
		test.effect(
			`unverified premise ${JSON.stringify(premise)} gets a correction turn`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* ValidatorService.use(validator =>
							validator.validate(finding(), CONTEXT)
						)
					).toMatchObject({
						status: 'unverified',
						premise: 'Example Router passes a URL.',
					})
					const calls = yield* ScriptedLlm.use(script => script.calls)
					expect(calls).toHaveLength(2)
					expect(calls.map(call => call.model.model)).toEqual([
						'model-b',
						'model-b',
					])
					expect(calls[1]?.options.prompt.content.at(-1)).toMatchObject({
						role: 'tool',
						content: [
							expect.objectContaining({
								result: expect.stringContaining('premise') as unknown,
							}) as unknown,
						],
					})
				}).pipe(
					Effect.provide(
						validatorLayer((_call, index) =>
							Effect.succeed(
								answer(
									'report_verdict',
									verdict({
										verdict: 'unverified',
										...(index === 0
											? premise === undefined
												? {}
												: { premise }
											: { premise: 'Example Router passes a URL.' }),
									})
								)
							)
						)
					)
				)
		)
	test.effect(
		'rejection with empty evidence stays unverified at reported severity with the reason and model',
		() =>
			Effect.gen(function* () {
				expect(
					yield* ValidatorService.use(validator =>
						validator.validate(finding(), CONTEXT)
					)
				).toMatchObject({
					status: 'unverified',
					severity: finding().severity,
					premise: UNNAMED_PREMISE,
					note: expect.stringContaining('without citing lines') as unknown,
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
	for (const existingAt of [SCOPE.change.head.commit, SCOPE.change.mergeBase])
		test.effect(
			`rejection citing a file existing only at ${existingAt} stays rejected`,
			() =>
				Effect.gen(function* () {
					const getFilesAtSpy = vi.fn<GitService['Service']['getFilesAt']>(
						(commit, paths) =>
							Effect.succeed(new Set(commit === existingAt ? paths : []))
					)
					yield* Effect.gen(function* () {
						expect(
							yield* ValidatorService.use(validator =>
								validator.validate(finding(), CONTEXT)
							)
						).toMatchObject({
							status: 'rejected',
							severity: finding().severity,
						})
						expect(getFilesAtSpy).toHaveBeenCalledTimes(2)
						for (const commit of [
							SCOPE.change.head.commit,
							SCOPE.change.mergeBase,
						])
							expect(getFilesAtSpy).toHaveBeenCalledWith(commit, [BILLING_PATH])
					}).pipe(
						Effect.provide(
							ValidatorServiceLive.pipe(
								Layer.provideMerge(
									reviewDependencies(
										() =>
											Effect.succeed(
												answer('report_verdict', verdict({ verdict: 'reject' }))
											),
										{},
										gitFixture({ getFilesAt: getFilesAtSpy })
									)
								)
							)
						)
					)
				})
		)
	for (const evidence of [
		['missing/source.ts:7 not present', 'missing/other.ts:4 also absent'],
		['node_modules/example/index.d.ts:12 remembered API'],
		['../outside.ts:2 outside repository'],
	])
		test.effect(
			`rejection without repository files stays unverified: ${JSON.stringify(evidence)}`,
			() =>
				Effect.gen(function* () {
					const premise = 'Example SDK returns an absolute URL.'
					const getFilesAtSpy = vi.fn<GitService['Service']['getFilesAt']>(() =>
						Effect.succeed(new Set())
					)
					yield* Effect.gen(function* () {
						expect(
							yield* ValidatorService.use(validator =>
								validator.validate(finding({ severity: 'high' }), CONTEXT)
							)
						).toMatchObject({
							status: 'unverified',
							severity: 'high',
							premise,
							evidence,
							note: expect.stringContaining('without citing lines') as unknown,
						})
						expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(
							1
						)
						expect(getFilesAtSpy).toHaveBeenCalledTimes(
							evidence[0]?.startsWith('../') ? 0 : 2
						)
					}).pipe(
						Effect.provide(
							ValidatorServiceLive.pipe(
								Layer.provideMerge(
									reviewDependencies(
										() =>
											Effect.succeed(
												answer(
													'report_verdict',
													verdict({
														verdict: 'reject',
														severity: 'low',
														evidence,
														premise,
													})
												)
											),
										{},
										gitFixture({ getFilesAt: getFilesAtSpy })
									)
								)
							)
						)
					)
				})
		)
	for (const path of ['.mng/MEMORY.md', '.mng/CONTEXT.md'])
		test.effect(
			`rejection citing ${path} stays rejected without checking git files`,
			() =>
				Effect.gen(function* () {
					const getFilesAtSpy = vi.fn<GitService['Service']['getFilesAt']>(() =>
						Effect.die('rules need no git check')
					)
					yield* Effect.gen(function* () {
						expect(
							yield* ValidatorService.use(validator =>
								validator.validate(finding(), CONTEXT)
							)
						).toMatchObject({ status: 'rejected' })
						expect(getFilesAtSpy).not.toHaveBeenCalled()
					}).pipe(
						Effect.provide(
							ValidatorServiceLive.pipe(
								Layer.provideMerge(
									reviewDependencies(
										() =>
											Effect.succeed(
												answer(
													'report_verdict',
													verdict({
														verdict: 'reject',
														evidence: [`${path}:1 intentional`],
													})
												)
											),
										{},
										gitFixture({ getFilesAt: getFilesAtSpy })
									)
								)
							)
						)
					)
				})
		)
	for (const path of ['.mng/MEMORY.md', '.mng/CONTEXT.md'])
		test.effect(
			`rejection citing ${path} that was not supplied is checked in git and kept unverified`,
			() =>
				Effect.gen(function* () {
					const getFilesAtSpy = vi.fn<GitService['Service']['getFilesAt']>(() =>
						Effect.succeed(new Set<string>())
					)
					const context = {
						...CONTEXT,
						rules: { ...CONTEXT.rules, context: '', memory: '  ' },
					}
					yield* Effect.gen(function* () {
						expect(
							yield* ValidatorService.use(validator =>
								validator.validate(finding(), context)
							)
						).toMatchObject({ status: 'unverified' })
						expect(getFilesAtSpy).toHaveBeenCalledTimes(2)
					}).pipe(
						Effect.provide(
							ValidatorServiceLive.pipe(
								Layer.provideMerge(
									reviewDependencies(
										() =>
											Effect.succeed(
												answer(
													'report_verdict',
													verdict({
														verdict: 'reject',
														evidence: [`${path}:1 intentional`],
													})
												)
											),
										{},
										gitFixture({ getFilesAt: getFilesAtSpy })
									)
								)
							)
						)
					)
				})
		)
	test.effect(
		'a git file lookup failure keeps a rejection unverified without retrying the model',
		() =>
			Effect.gen(function* () {
				const getFilesAtSpy = vi.fn<GitService['Service']['getFilesAt']>(() =>
					Effect.fail(
						new GitError({
							args: ['ls-tree'],
							stderr: 'fixture git failure',
							exitCode: 128,
						})
					)
				)
				yield* Effect.gen(function* () {
					expect(
						yield* ValidatorService.use(validator =>
							validator.validate(finding(), CONTEXT)
						)
					).toMatchObject({
						status: 'unverified',
						severity: finding().severity,
						premise: UNNAMED_PREMISE,
						note: expect.stringContaining('without citing lines') as unknown,
					})
					expect(getFilesAtSpy).toHaveBeenCalled()
					expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(1)
				}).pipe(
					Effect.provide(
						ValidatorServiceLive.pipe(
							Layer.provideMerge(
								reviewDependencies(
									() =>
										Effect.succeed(
											answer('report_verdict', verdict({ verdict: 'reject' }))
										),
									{},
									gitFixture({ getFilesAt: getFilesAtSpy })
								)
							)
						)
					)
				)
			})
	)
	for (const verdictName of ['confirm', 'reject', 'unverified'])
		for (const loweredBecause of [
			undefined,
			'high: no main flow fails and no wrong data is returned.',
		])
			test.effect(
				`${verdictName} lowering ${loweredBecause ? 'with' : 'without'} lowered_because is enforced through the model tool`,
				() =>
					Effect.gen(function* () {
						const validation = yield* ValidatorService.use(validator =>
							validator.validate(finding({ severity: 'high' }), CONTEXT)
						)
						expect(validation).toMatchObject({
							status:
								verdictName === 'confirm'
									? 'confirmed'
									: verdictName === 'reject'
										? 'rejected'
										: 'unverified',
							severity: loweredBecause ? 'medium' : 'high',
						})
						if (loweredBecause) {
							expect(validation).toHaveProperty(
								'loweredBecause',
								loweredBecause
							)
							expect(validation).not.toHaveProperty('note')
						} else {
							expect(validation).toHaveProperty(
								'note',
								expect.stringContaining('without naming the criterion')
							)
							expect(validation).not.toHaveProperty('loweredBecause')
						}
						expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(
							1
						)
					}).pipe(
						Effect.provide(
							validatorLayer(() =>
								Effect.succeed(
									answer(
										'report_verdict',
										verdict({
											verdict: verdictName,
											...(verdictName === 'unverified'
												? { premise: 'Example SDK retries automatically.' }
												: {}),
											...(loweredBecause
												? { lowered_because: loweredBecause }
												: {}),
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
									Layer.succeed(RepoToolsService, {
										call: callSpy,
										run: (scope, name, params) =>
											callSpy(scope, name, params).pipe(
												Effect.map(output => ({ output }))
											),
									})
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

layer(Layer.empty)('ValidatorService.validateAll', test => {
	for (const status of ['confirm', 'unverified'] as const)
		test.effect(
			`${status} absorbs only named nearby reports with all provenance`,
			() =>
				Effect.gen(function* () {
					const first = finding({ severity: 'high', evidence: ['first'] })
					const duplicate = finding({
						agents: ['agent-b'],
						models: ['model-c'],
						title: 'Another description',
						evidence: ['second'],
					})
					const output = yield* ValidatorService.use(validator =>
						validator.validateAll([first, duplicate], CONTEXT)
					)
					expect(output.bugs).toEqual([absorb(first, duplicate)])
					expect(output.validations).toMatchObject([
						{
							status: status === 'confirm' ? 'confirmed' : 'unverified',
							severity: 'high',
						},
					])
					const calls = yield* ScriptedLlm.use(script => script.calls)
					expect(calls).toHaveLength(1)
					expect(
						calls[0]?.options.prompt.content.map(message => message.role)
					).toEqual(['system', 'user'])
					expect(userText(calls[0])).toContain(
						`Nearby findings from other reviewers in ${BILLING_PATH}:`
					)
					expect(userText(calls[0])).toContain('"number": 1')
					expect(userText(calls[0])).toContain('Another description')
					expect(userText(calls[0])).toContain(duplicate.trigger)
					expect(userText(calls[0])).toContain(duplicate.impact)
				}).pipe(
					Effect.provide(
						validatorLayer(() =>
							Effect.succeed(
								answer(
									'report_verdict',
									verdict({
										verdict: status,
										premise: 'The SDK retries writes.',
										same_root_cause: [1],
									})
								)
							)
						)
					)
				)
		)
	test.effect(
		'a rejection absorbs nothing even when it names the nearby finding',
		() =>
			Effect.gen(function* () {
				const bugs = [
					finding(),
					finding({ agents: ['agent-b'], title: 'Other failure' }),
				]
				const output = yield* ValidatorService.use(validator =>
					validator.validateAll(bugs, CONTEXT)
				)
				expect(output.bugs).toEqual(bugs)
				expect(output.validations.map(validation => validation.status)).toEqual(
					['rejected', 'confirmed']
				)
				const calls = yield* ScriptedLlm.use(script => script.calls)
				expect(calls).toHaveLength(2)
				expect(userText(calls[1])).toContain('Other failure')
				expect(userText(calls[1])).not.toContain(
					'Nearby findings from other reviewers'
				)
			}).pipe(
				Effect.provide(
					validatorLayer((_call, index) =>
						Effect.succeed(
							answer(
								'report_verdict',
								verdict({
									verdict: index === 0 ? 'reject' : 'confirm',
									same_root_cause: [1],
								})
							)
						)
					)
				)
			)
	)
	test.effect(
		'a rejection kept as unverified absorbs nothing and validates its named neighbor independently',
		() =>
			Effect.gen(function* () {
				const bugs = [
					finding({ severity: 'high' }),
					finding({ agents: ['agent-b'], title: 'Other failure' }),
				]
				const output = yield* ValidatorService.use(validator =>
					validator.validateAll(bugs, CONTEXT)
				)
				expect(output.bugs).toEqual(bugs)
				expect(output.validations).toMatchObject([
					{ status: 'unverified', severity: 'high', evidence: [] },
					{ status: 'confirmed', severity: 'medium' },
				])
				const calls = yield* ScriptedLlm.use(script => script.calls)
				expect(calls).toHaveLength(2)
				expect(userText(calls[0])).toContain('"number": 1')
				expect(userText(calls[0])).toContain('Other failure')
				expect(userText(calls[1])).toContain('Other failure')
				expect(userText(calls[1])).not.toContain(
					'Nearby findings from other reviewers'
				)
			}).pipe(
				Effect.provide(
					validatorLayer((_call, index) =>
						Effect.succeed(
							answer(
								'report_verdict',
								verdict(
									index === 0
										? { verdict: 'reject', evidence: [], same_root_cause: [1] }
										: {}
								)
							)
						)
					)
				)
			)
	)
	test.effect(
		'an unvalidated first report leaves its neighbor for an independent validation',
		() =>
			Effect.gen(function* () {
				const bugs = [
					finding(),
					finding({ agents: ['agent-b'], title: 'Other failure' }),
				]
				const output = yield* ValidatorService.use(validator =>
					validator.validateAll(bugs, CONTEXT)
				)
				expect(output.bugs).toEqual(bugs)
				expect(output.validations.map(validation => validation.status)).toEqual(
					['unvalidated', 'confirmed']
				)
				const calls = yield* ScriptedLlm.use(script => script.calls)
				expect(calls).toHaveLength(3)
				expect(userText(calls[2])).toContain('Other failure')
			}).pipe(
				Effect.provide(
					validatorLayer((_call, index) =>
						index < 2
							? Effect.fail(providerError(500))
							: Effect.succeed(
									answer('report_verdict', verdict({ same_root_cause: [1] }))
								)
					)
				)
			)
	)
	test.effect(
		'out-of-range nearby numbers are ignored and the remainder continues sequentially',
		() =>
			Effect.gen(function* () {
				const first = finding({ title: 'First report' })
				const second = finding({ title: 'Second report', agents: ['agent-b'] })
				const third = finding({ title: 'Third report', agents: ['agent-c'] })
				const output = yield* ValidatorService.use(validator =>
					validator.validateAll([first, second, third], CONTEXT)
				)
				expect(output.bugs).toEqual([first, absorb(second, third)])
				expect(output.validations.map(validation => validation.status)).toEqual(
					['confirmed', 'confirmed']
				)
				const calls = yield* ScriptedLlm.use(script => script.calls)
				expect(calls).toHaveLength(2)
				expect(userText(calls[0])).toContain('"number": 2')
				expect(userText(calls[1])).toContain('Second report')
				expect(userText(calls[1])).toContain('Third report')
				expect(userText(calls[1])).not.toContain('First report')
				expect(userText(calls[1])).not.toContain('"number": 2')
			}).pipe(
				Effect.provide(
					validatorLayer((_call, index) =>
						Effect.succeed(
							answer(
								'report_verdict',
								verdict({ same_root_cause: index === 0 ? [99] : [1, 1, 99] })
							)
						)
					)
				)
			)
	)
	test.effect(
		'same-finder reports are excluded from the nearby list even through a chain',
		() =>
			Effect.gen(function* () {
				const first = finding({ line: 1, title: 'First report' })
				const second = finding({
					line: 1 + NEAR_LINES,
					title: 'Same finder report',
				})
				const bridge = finding({
					line: 1 + NEAR_LINES,
					title: 'Bridge report',
					agents: ['agent-b'],
				})
				const output = yield* ValidatorService.use(validator =>
					validator.validateAll([first, second, bridge], CONTEXT)
				)
				expect(output.bugs).toEqual([absorb(first, bridge), second])
				const calls = yield* ScriptedLlm.use(script => script.calls)
				expect(calls).toHaveLength(2)
				expect(userText(calls[0])).toContain('Bridge report')
				expect(userText(calls[0])).not.toContain('Same finder report')
				expect(userText(calls[1])).not.toContain(
					'Nearby findings from other reviewers'
				)
			}).pipe(
				Effect.provide(
					validatorLayer(() =>
						Effect.succeed(
							answer('report_verdict', verdict({ same_root_cause: [1] }))
						)
					)
				)
			)
	)
	test.effect(
		'separate singletons preserve findings and receive fresh validation contexts',
		() =>
			Effect.gen(function* () {
				const bugs = [
					finding(),
					finding({ line: 2 + NEAR_LINES + 1, agents: ['agent-b'] }),
				]
				const output = yield* ValidatorService.use(validator =>
					validator.validateAll(bugs, CONTEXT)
				)
				expect(output.bugs).toEqual(bugs)
				expect(output.validations.map(validation => validation.status)).toEqual(
					['confirmed', 'confirmed']
				)
				const calls = yield* ScriptedLlm.use(script => script.calls)
				expect(calls).toHaveLength(2)
				for (const call of calls) {
					expect(
						call.options.prompt.content.map(message => message.role)
					).toEqual(['system', 'user'])
					expect(userText(call)).not.toContain(
						'Nearby findings from other reviewers'
					)
				}
			}).pipe(
				Effect.provide(
					validatorLayer(() =>
						Effect.succeed(
							answer('report_verdict', verdict({ same_root_cause: [1] }))
						)
					)
				)
			)
	)
	test.effect('empty input starts no validation', () =>
		Effect.gen(function* () {
			expect(
				yield* ValidatorService.use(validator =>
					validator.validateAll([], CONTEXT)
				)
			).toEqual({ bugs: [], validations: [] })
			expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(0)
		}).pipe(
			Effect.provide(validatorLayer(() => Effect.die('unexpected model call')))
		)
	)
})

layer(Layer.empty)('group validation scheduling', test => {
	test.effect(
		'validates groups in parallel while awaiting each group first verdict before its remainder',
		() =>
			Effect.gen(function* () {
				const firstEntered = yield* Deferred.make<void>()
				const otherEntered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const first = finding({ title: 'First group report' })
				const remainder = finding({
					title: 'Remainder report',
					agents: ['agent-b'],
				})
				const other = finding({ path: 'other.ts', title: 'Other group report' })
				const schedulingScript: ScriptedLlmAnswer = call => {
					const text = userText(call)
					if (text.includes('"title": "First group report"'))
						return Deferred.succeed(firstEntered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as(answer('report_verdict', verdict()))
						)
					if (text.includes('"title": "Other group report"'))
						return Deferred.succeed(otherEntered, undefined).pipe(
							Effect.as(answer('report_verdict', verdict()))
						)
					return Effect.succeed(answer('report_verdict', verdict()))
				}
				yield* Effect.gen(function* () {
					const pending = yield* ValidatorService.use(validator =>
						validator.validateAll([first, remainder, other], CONTEXT)
					).pipe(Effect.forkChild)
					yield* Deferred.await(firstEntered)
					yield* Deferred.await(otherEntered)
					const calls = yield* ScriptedLlm.use(script => script.calls)
					expect(calls).toHaveLength(2)
					expect(
						calls.filter(call => userText(call).includes('Other group report'))
					).toHaveLength(1)
					yield* Deferred.succeed(release, undefined)
					const output = yield* Fiber.join(pending)
					expect(output.bugs).toEqual([first, remainder, other])
					expect(output.validations).toHaveLength(3)
					expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(3)
				}).pipe(
					Effect.provide(validatorLayer(schedulingScript, { concurrency: 3 }))
				)
			})
	)
	for (const invalid of [0, -1, 1.5])
		test.effect(
			`the verdict tool corrects invalid same_root_cause number ${invalid}`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* ValidatorService.use(validator =>
							validator.validateAll(
								[
									finding(),
									finding({ agents: ['agent-b'], title: 'Other failure' }),
								],
								CONTEXT
							)
						)
					).toMatchObject({
						bugs: [{ agents: ['reviewer', 'agent-b'] }],
						validations: [{ status: 'confirmed' }],
					})
					const calls = yield* ScriptedLlm.use(script => script.calls)
					expect(calls).toHaveLength(2)
					expect(JSON.stringify(calls[1]?.options.prompt)).toContain(
						'same_root_cause'
					)
				}).pipe(
					Effect.provide(
						validatorLayer((_call, index) =>
							Effect.succeed(
								answer(
									'report_verdict',
									verdict({ same_root_cause: [index === 0 ? invalid : 1] })
								)
							)
						)
					)
				)
		)
})
