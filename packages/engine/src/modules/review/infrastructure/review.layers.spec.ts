import { layer } from '@effect/vitest'
import { parseReviewConfig } from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import {
	RulesService,
	RulesServiceLive,
} from '../../../platform/config/rules.service'
import { GitService } from '../../../platform/git/git.service'
import {
	makeScriptedLlmLayer,
	ScriptedLlm,
	type ScriptedLlmAnswer,
} from '../../../platform/llm/scripted-llm.layer'
import {
	TokenLedger,
	TokenLedgerLive,
} from '../../../platform/llm/token-ledger.service'
import {
	agent,
	config,
	rawFinding,
} from '../../../shared/mocks/domain-test.helper'
import {
	cleanupRepos,
	createRepo,
	FileSystemLayer,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import {
	gitFixture,
	offers,
	providerError,
	userText,
} from '../../../shared/mocks/review-layer.helper'
import {
	answer,
	DIFF,
	FINISH,
	LIMITS,
	MODEL,
	REVIEWERS,
	reviewRequest,
	toolCall,
	verdict,
} from '../../../shared/mocks/review-test.helper'
import { ReviewLimits } from '../application/review-limits.context'
import { ReviewService } from '../application/services/review.service'
import { ReviewPipelineLive } from './review.layers'

/** The whole pipeline with real tool execution and model decoding, over offline ports. */
function pipelineLayer(
	script: ScriptedLlmAnswer,
	limits: Partial<ReviewLimits['Service']> = {},
	git = gitFixture()
) {
	return ReviewPipelineLive.pipe(
		Layer.provideMerge(makeScriptedLlmLayer(script)),
		Layer.provideMerge(TokenLedgerLive),
		Layer.provide(Layer.succeed(ReviewLimits, { ...LIMITS, ...limits })),
		Layer.provide(Layer.succeed(GitService, git))
	)
}

/** A valid response for whichever conversation the pipeline opened. */
const emptyScript: ScriptedLlmAnswer = call =>
	Effect.succeed(
		offers(call, 'report_verdict')
			? answer('report_verdict', verdict())
			: answer()
	)

layer(Layer.empty)('ReviewPipelineLive', test => {
	test.effect(
		'merges agents by root cause, validates once per bug, re-rates and retains rejected reasons and tokens',
		() =>
			Effect.gen(function* () {
				const request = reviewRequest(
					config({
						models: {
							reviewer: REVIEWERS,
							agents: MODEL,
							validator: { model: 'validator', effort: 'high' },
						},
					}),
					[agent('billing')]
				)
				const report = yield* ReviewService.use(review =>
					review.review(request)
				)
				expect(report.endpointError).toBeUndefined()
				expect(report.blocking).toBe(true)
				expect(report.agents).toMatchObject([
					{ name: 'reviewer', status: 'ok', findings: 2 },
					{ name: 'billing', status: 'ok', findings: 2 },
				])
				expect(report.bugs).toMatchObject([
					{
						agents: ['reviewer', 'billing'],
						models: ['model-a'],
						severity: 'high',
						reportedSeverity: 'medium',
						placement: 'inline',
						validation: { status: 'confirmed', model: 'validator' },
					},
				])
				expect(report.rejected).toMatchObject([
					{
						title: 'Missing invoice ownership guard',
						reason: 'Caller checks ownership.',
						validatedBy: 'validator',
						agents: ['reviewer', 'billing'],
					},
				])
				expect(report.tokens).toMatchObject({
					'model-a': { calls: 2, totalTokens: 10 },
					validator: { calls: 2, totalTokens: 10 },
				})
				expect(
					(yield* ScriptedLlm.use(script => script.calls)).filter(call =>
						offers(call, 'report_verdict')
					)
				).toHaveLength(2)
			}).pipe(
				Effect.provide(
					pipelineLayer(call =>
						Effect.succeed(
							offers(call, 'report_findings')
								? answer('report_findings', {
										findings: [
											rawFinding(),
											rawFinding({
												title: 'Missing invoice ownership guard',
												line: 20,
											}),
										],
									})
								: answer(
										'report_verdict',
										verdict(
											userText(call).includes('Missing invoice ownership guard')
												? {
														verdict: 'reject',
														reason: 'Caller checks ownership.',
													}
												: { severity: 'high' }
										)
									)
						)
					)
				)
			)
	)
	for (const depth of ['balanced', 'deep'] as const)
		test.effect(
			`${depth} uses planned reviewer models and deep function fan-out`,
			() =>
				Effect.gen(function* () {
					const report = yield* ReviewService.use(review =>
						review.review(
							reviewRequest(config({ depth, models: { reviewer: REVIEWERS } }))
						)
					)
					expect(report.agents.map(run => run.model)).toEqual(
						depth === 'deep' ? ['model-a', 'model-b'] : ['model-a']
					)
					const calls = yield* ScriptedLlm.use(script => script.calls)
					expect(calls).toHaveLength(depth === 'deep' ? 4 : 1)
					if (depth === 'deep') {
						expect(report.agents.map(run => run.units)).toEqual([2, 2])
						for (const model of REVIEWERS)
							expect(
								calls
									.filter(
										call =>
											call.model.model === model.model &&
											call.options.prompt.content.length === 2
									)
									.map(userText)
							).toEqual([
								expect.stringContaining('charge0') as unknown,
								expect.stringContaining('charge1') as unknown,
							])
					}
				}).pipe(
					Effect.provide(
						pipelineLayer(
							emptyScript,
							{},
							gitFixture({
								readDiff: () =>
									Effect.succeed(
										`${DIFF}@@ -20 +20 @@ export function charge1() {\n-before\n+after\n`
									),
							})
						)
					)
				)
		)
	test.effect(
		'different findings from deep models are cross-validated and metered per model',
		() =>
			Effect.gen(function* () {
				const report = yield* ReviewService.use(review =>
					review.review(
						reviewRequest(
							config({
								depth: 'deep',
								models: { reviewer: REVIEWERS, validator: 'cross' },
							})
						)
					)
				)
				expect(report.bugs).toMatchObject([
					{
						models: ['model-a'],
						validation: { model: 'model-b', status: 'confirmed' },
					},
					{
						models: ['model-b'],
						validation: { model: 'model-a', status: 'confirmed' },
					},
				])
				expect(report.tokens).toMatchObject({
					'model-a': { calls: 2, totalTokens: 10 },
					'model-b': { calls: 2, totalTokens: 10 },
				})
				expect(
					(yield* ScriptedLlm.use(script => script.calls)).filter(call =>
						offers(call, 'report_verdict')
					)
				).toHaveLength(2)
			}).pipe(
				Effect.provide(
					pipelineLayer(call =>
						Effect.succeed(
							offers(call, 'report_verdict')
								? answer('report_verdict', verdict())
								: answer('report_findings', {
										findings: [
											rawFinding(
												call.model.model === 'model-a'
													? {}
													: {
															title: 'Missing invoice ownership guard',
															line: 20,
														}
											),
										],
									})
						)
					)
				)
			)
	)
	test.effect(
		'finding reported by both models merges their provenance and validates once',
		() =>
			Effect.gen(function* () {
				const report = yield* ReviewService.use(review =>
					review.review(
						reviewRequest(
							config({
								depth: 'deep',
								models: { reviewer: REVIEWERS, validator: 'cross' },
							})
						)
					)
				)
				expect(report.bugs).toMatchObject([
					{
						agents: ['reviewer'],
						models: ['model-a', 'model-b'],
						validation: { model: 'model-a' },
					},
				])
				expect(report.bugs).toHaveLength(1)
				expect(
					(yield* ScriptedLlm.use(script => script.calls)).filter(call =>
						offers(call, 'report_verdict')
					)
				).toHaveLength(1)
			}).pipe(
				Effect.provide(
					pipelineLayer(call =>
						Effect.succeed(
							offers(call, 'report_verdict')
								? answer('report_verdict', verdict())
								: answer('report_findings', { findings: [rawFinding()] })
						)
					)
				)
			)
	)
	for (const form of ['object', 'list'] as const)
		test.effect(
			`one ${form} reviewer cross-validates in a fresh conversation on the same model`,
			() =>
				Effect.gen(function* () {
					const cfg = yield* parseReviewConfig(
						`models:\n  reviewer: ${form === 'object' ? '{model: model-a, effort: high}' : '[{model: model-a, effort: high}]'}\n  validator: cross`
					)
					const report = yield* ReviewService.use(review =>
						review.review(reviewRequest(cfg))
					)
					expect(report.bugs[0]?.validation).toMatchObject({
						model: 'model-a',
						status: 'confirmed',
					})
					const calls = yield* ScriptedLlm.use(script => script.calls)
					const validators = calls.filter(call =>
						offers(call, 'report_verdict')
					)
					expect(validators).toHaveLength(1)
					expect(
						validators[0]?.options.prompt.content.map(message => message.role)
					).toEqual(['system', 'user'])
					expect(JSON.stringify(validators[0]?.options.prompt)).not.toContain(
						'Finder-only marker'
					)
					expect(
						JSON.stringify(
							calls.find(call => call.options.prompt.content.length > 2)
								?.options.prompt
						)
					).toContain('Finder-only marker')
				}).pipe(
					Effect.provide(
						pipelineLayer(call =>
							Effect.succeed(
								offers(call, 'report_verdict')
									? answer('report_verdict', verdict())
									: call.options.prompt.content.length === 2
										? [
												{ type: 'text', text: 'Finder-only marker' },
												toolCall('read_file', { path: rawFinding().path }),
												FINISH,
											]
										: answer('report_findings', { findings: [rawFinding()] })
							)
						)
					)
				)
		)
	test.effect(
		'declared agent finding is validated by a different reviewer model',
		() =>
			Effect.gen(function* () {
				const request = reviewRequest(
					config({
						models: { reviewer: REVIEWERS, agents: MODEL, validator: 'cross' },
					}),
					[agent('billing')]
				)
				const report = yield* ReviewService.use(review =>
					review.review(request)
				)
				expect(report.bugs).toMatchObject([
					{
						agents: ['billing'],
						models: ['model-a'],
						validation: { model: 'model-b' },
					},
				])
			}).pipe(
				Effect.provide(
					pipelineLayer(call =>
						Effect.succeed(
							offers(call, 'report_verdict')
								? answer('report_verdict', verdict())
								: answer('report_findings', {
										findings: JSON.stringify(
											call.options.prompt.content[0]
										).includes('You are a review agent:')
											? [rawFinding()]
											: [],
									})
						)
					)
				)
			)
	)
	test.effect(
		'normal dropped reviewer and declared agents fall back to the next model',
		() =>
			Effect.gen(function* () {
				const report = yield* ReviewService.use(review =>
					review.review(
						reviewRequest(
							config({
								models: {
									reviewer: REVIEWERS,
									agents: MODEL,
									validator: 'cross',
								},
							}),
							[agent('billing')]
						)
					)
				)
				expect(report.agents).toMatchObject([
					{ model: 'model-b', fellBackFrom: 'model-a', status: 'ok' },
					{ model: 'model-b', fellBackFrom: 'model-a', status: 'ok' },
				])
				expect(report.endpointError).toBeUndefined()
				expect(report.droppedModels).toEqual([
					{ model: 'model-a', reason: 'rate limited (429)' },
				])
			}).pipe(
				Effect.provide(
					pipelineLayer(call =>
						call.model.model === 'model-a'
							? Effect.fail(providerError(429))
							: Effect.succeed(answer())
					)
				)
			)
	)
	test.effect(
		'deep dropped reviewer is reported without a replacement and surviving findings remain',
		() =>
			Effect.gen(function* () {
				const report = yield* ReviewService.use(review =>
					review.review(
						reviewRequest(
							config({
								depth: 'deep',
								models: { reviewer: REVIEWERS, validator: 'cross' },
							})
						)
					)
				)
				expect(report.agents).toMatchObject([
					{ model: 'model-a', status: 'ok' },
					{ model: 'model-b', status: 'failed' },
				])
				expect(report.agents.every(run => run.fellBackFrom === undefined)).toBe(
					true
				)
				expect(report.droppedModels).toEqual([
					{ model: 'model-b', reason: 'unavailable (503)' },
				])
				expect(report.endpointError).toBeUndefined()
				expect(report.bugs).toMatchObject([
					{ validation: { model: 'model-a' } },
				])
				expect(
					(yield* ScriptedLlm.use(script => script.calls)).filter(call =>
						offers(call, 'report_findings')
					)
				).toHaveLength(2)
			}).pipe(
				Effect.provide(
					pipelineLayer(call =>
						call.model.model === 'model-b'
							? Effect.fail(providerError(503))
							: Effect.succeed(
									offers(call, 'report_verdict')
										? answer('report_verdict', verdict())
										: answer('report_findings', { findings: [rawFinding()] })
								)
					)
				)
			)
	)
	for (const depth of ['balanced', 'deep'] as const)
		test.effect(
			`all reviewers dropped at ${depth} produces endpointError`,
			() =>
				Effect.gen(function* () {
					const report = yield* ReviewService.use(review =>
						review.review(
							reviewRequest(config({ depth, models: { reviewer: REVIEWERS } }))
						)
					)
					expect(report.endpointError).toContain('no reviewer model left:')
					expect(report.droppedModels).toHaveLength(2)
					expect(report.bugs).toEqual([])
					expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(2)
				}).pipe(
					Effect.provide(
						pipelineLayer(call =>
							Effect.fail(
								providerError(call.model.model === 'model-a' ? 429 : 503)
							)
						)
					)
				)
		)
	test.effect('finder endpoint failure is reported as endpointError', () =>
		Effect.gen(function* () {
			const report = yield* ReviewService.use(review =>
				review.review(reviewRequest())
			)
			expect(report.endpointError).toContain('reviewer:')
			expect(report.agents).toMatchObject([
				{ status: 'failed', endpointError: true },
			])
		}).pipe(
			Effect.provide(pipelineLayer(() => Effect.fail(providerError(500))))
		)
	)
	for (const stage of ['before finding', 'after finding'] as const)
		test.effect(
			`token budget spent ${stage} stops calls without endpointError`,
			() =>
				Effect.gen(function* () {
					if (stage === 'before finding')
						yield* TokenLedger.use(ledger =>
							ledger.record('router', FINISH.usage)
						)
					const report = yield* ReviewService.use(review =>
						review.review(reviewRequest())
					)
					expect(report.endpointError).toBeUndefined()
					expect(report.droppedModels).toEqual([])
					expect(report.incomplete).toEqual({
						reason: 'limits.tokens_per_run (5) reached',
						unfinished:
							stage === 'before finding'
								? ['reviewer']
								: ['validation of 1 finding(s)'],
					})
					expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(
						stage === 'before finding' ? 0 : 1
					)
					if (stage === 'after finding') {
						expect(report.bugs).toMatchObject([
							{
								validation: {
									status: 'unvalidated',
									budgetSpent: true,
									error: expect.stringContaining(
										'token budget spent'
									) as unknown,
								},
							},
						])
						expect(report.blocking).toBe(true)
					} else
						expect(report.agents).toMatchObject([
							{
								status: 'incomplete',
								unfinished: ['reviewer'],
								error: expect.stringContaining('token budget spent') as unknown,
							},
						])
				}).pipe(
					Effect.provide(
						pipelineLayer(
							() =>
								Effect.succeed(
									answer('report_findings', { findings: [rawFinding()] })
								),
							{ tokensPerRun: 5 }
						)
					)
				)
		)

	for (const form of ['object', 'list'] as const)
		for (const depth of ['balanced', 'deep'] as const)
			test.effect(`one ${form} reviewer runs once at ${depth} depth`, () =>
				Effect.gen(function* () {
					const cfg = yield* parseReviewConfig(
						`depth: ${depth}\nmodels:\n  reviewer: ${
							form === 'object'
								? '{model: model-a, effort: high}'
								: '[{model: model-a, effort: high}]'
						}`
					)
					const report = yield* ReviewService.use(review =>
						review.review(reviewRequest(cfg))
					)
					expect(report.agents).toMatchObject([
						{ name: 'reviewer', model: 'model-a', status: 'ok' },
					])
					expect(report.agents).toHaveLength(1)
					expect(report.endpointError).toBeUndefined()
					expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(1)
					expect(report.agents[0]?.continued).toBeUndefined()
				}).pipe(Effect.provide(pipelineLayer(emptyScript)))
			)
	for (const kind of ['bug', 'nit'] as const)
		test.effect(
			`declared ${kind} agent alone falls back and validates only bugs`,
			() =>
				Effect.gen(function* () {
					const request = reviewRequest(
						config({
							features: { reviewer: 'off' },
							models: {
								reviewer: REVIEWERS,
								agents: MODEL,
								validator: 'cross',
							},
						}),
						[agent('billing', { kind })]
					)
					const report = yield* ReviewService.use(review =>
						review.review(request)
					)
					expect(report.agents).toMatchObject([
						{
							name: 'billing',
							kind,
							model: 'model-b',
							status: 'ok',
							fellBackFrom: 'model-a',
						},
					])
					expect(report.endpointError).toBeUndefined()
					expect(report.droppedModels).toEqual([
						{ model: 'model-a', reason: 'unavailable (503)' },
					])
					expect(kind === 'bug' ? report.bugs : report.nits).toMatchObject([
						{ kind, agents: ['billing'], models: ['model-b'] },
					])
					expect(
						(yield* ScriptedLlm.use(script => script.calls))
							.filter(call => offers(call, 'report_verdict'))
							.map(call => call.model.model)
					).toEqual(kind === 'bug' ? ['model-b'] : [])
				}).pipe(
					Effect.provide(
						pipelineLayer(call =>
							call.model.model === 'model-a'
								? Effect.fail(providerError(503))
								: Effect.succeed(
										offers(call, 'report_verdict')
											? answer('report_verdict', verdict())
											: answer('report_findings', { findings: [rawFinding()] })
									)
						)
					)
				)
		)
})

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })(
	'ReviewPipelineLive committed notes',
	test => {
		for (const ref of [undefined, 'HEAD'])
			test.effect(
				`lowercase context in ${
					ref ?? 'working tree'
				} never reaches the main reviewer`,
				() =>
					Effect.gen(function* () {
						const repo = createRepo()
						repo.write(
							'.mng/context.md',
							'Lowercase notes must not reach the main reviewer.'
						)
						repo.write(
							'.mng/review.yml',
							'models:\n  reviewer: {model: model-a, effort: high}\n'
						)
						repo.write('src/billing/charge.ts', 'before\n')
						repo.commit()
						repo.git('checkout', '-b', 'feature')
						repo.write('src/billing/charge.ts', 'after\n')
						repo.commit()
						const rules = yield* RulesService.use(service =>
							service.load(ref)
						).pipe(
							Effect.provide(
								RulesServiceLive.pipe(
									Layer.provide(gitLayer(repo.root)),
									Layer.provide(FileSystemLayer)
								)
							)
						)
						const git = yield* GitService.pipe(
							Effect.provide(gitLayer(repo.root))
						)
						const change = yield* git.readChange('main', 'HEAD')
						const request = reviewRequest(rules.config)
						yield* Effect.gen(function* () {
							const report = yield* ReviewService.use(review =>
								review.review({
									...request,
									rules,
									planReport: { ...request.planReport, change },
								})
							)
							expect(report.agents[0]?.status).toBe('ok')
							const calls = yield* ScriptedLlm.use(script => script.calls)
							expect(calls).toHaveLength(1)
							expect(
								JSON.stringify(calls[0]?.options.prompt.content[0])
							).not.toContain('Lowercase notes')
							expect(
								JSON.stringify(calls[0]?.options.prompt.content[0])
							).not.toContain("Notes from the repository's maintainers:")
						}).pipe(Effect.provide(pipelineLayer(emptyScript, {}, git)))
					})
			)
	}
)
