import { layer } from '@effect/vitest'
import { Effect, Layer, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import { TokenLedgerLive } from '../../../../platform/llm/token-ledger.service'
import {
	agent,
	config,
	finding,
} from '../../../../shared/mocks/domain-test.helper'
import {
	LIMITS,
	reviewRequest,
} from '../../../../shared/mocks/review-test.helper'
import { ValidatorService } from '../../../validation/application/validator.service'
import type { DroppedModel } from '../../domain/review-report.types'
import { ReviewLimits } from '../review-limits.context'
import { FinderService, type FinderResult } from './finder.service'
import { ModelHealthService } from './model-health.service'
import { ReviewService, ReviewServiceLive } from './review.service'

/** Isolates placement and orchestration from model decoding, covered by the pipeline specs. */
function reviewLayer(
	find: FinderService['Service']['run'],
	validate: ValidatorService['Service']['validate'],
	dropped: ModelHealthService['Service']['dropped'] = Effect.succeed([])
) {
	return ReviewServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(FinderService, { run: find }),
				Layer.succeed(ValidatorService, { validate }),
				Layer.succeed(ModelHealthService, {
					run: () => Effect.die('unexpected model call'),
					isAvailable: () => Effect.succeed(true),
					dropped,
					spent: Effect.succeed(0),
				}),
				Layer.succeed(ReviewLimits, LIMITS),
				TokenLedgerLive
			)
		)
	)
}

/** A successful finder report with independently built finding provenance. */
function finderResult(
	findings: FinderResult['findings'],
	name = 'reviewer'
): FinderResult {
	return {
		findings,
		report: {
			name,
			title: name,
			kind: 'bug',
			model: 'model-a',
			effort: 'high',
			status: 'ok',
			toolCalls: 0,
			findings: findings.length,
			malformed: 0,
			wallMillis: 0,
		},
	}
}

layer(Layer.empty)('ReviewService', test => {
	test.effect(
		'keeps finished findings and reports unfinished units and skipped validations together',
		() =>
			Effect.gen(function* () {
				const found = finding()
				const done = finderResult([found])
				const report = yield* ReviewService.use(review =>
					review.review(reviewRequest())
				).pipe(
					Effect.provide(
						reviewLayer(
							() =>
								Effect.succeed({
									...done,
									report: {
										...done.report,
										status: 'incomplete',
										units: 2,
										unfinished: ['src/viewer.ts: close()'],
									},
								}),
							() =>
								Effect.succeed({
									status: 'unvalidated',
									error: 'token budget spent',
									budgetSpent: true,
								})
						)
					)
				)
				expect(report.bugs).toMatchObject([
					{
						title: found.title,
						fingerprint: found.fingerprint,
						validation: { status: 'unvalidated', budgetSpent: true },
					},
				])
				expect(report.agents).toMatchObject([
					{
						status: 'incomplete',
						findings: 1,
						unfinished: ['src/viewer.ts: close()'],
					},
				])
				expect(report.incomplete).toEqual({
					reason: `limits.tokens_per_run (${LIMITS.tokensPerRun}) reached`,
					unfinished: [
						'reviewer: src/viewer.ts: close()',
						'validation of 1 finding(s)',
					],
				})
				expect(report.endpointError).toBeUndefined()
				expect(report.blocking).toBe(true)
			})
	)
	test.effect('validates merged bugs once and never validates nits', () =>
		Effect.gen(function* () {
			const validateSpy = vi.fn<ValidatorService['Service']['validate']>(() =>
				Effect.succeed({ status: 'unvalidated', error: 'fixture' })
			)
			const findSpy = vi.fn<FinderService['Service']['run']>(run =>
				Effect.succeed(
					finderResult(
						[
							finding({ agents: [run.name] }),
							finding({ kind: 'nit', agents: [run.name] }),
						],
						run.name
					)
				)
			)
			const report = yield* ReviewService.use(review =>
				review.review(reviewRequest(config(), [agent('billing')]))
			).pipe(Effect.provide(reviewLayer(findSpy, validateSpy)))
			expect(validateSpy).toHaveBeenCalledTimes(1)
			expect(validateSpy.mock.calls[0]?.[0].agents).toEqual([
				'reviewer',
				'billing',
			])
			expect(report.bugs).toHaveLength(1)
			expect(report.nits).toHaveLength(1)
			expect(report.blocking).toBe(true)
		})
	)
	test.effect(
		'lowest severity floor among merged agents wins after validation re-rating',
		() =>
			Effect.gen(function* () {
				const request = reviewRequest(
					config({ comments: { min_severity: 'critical' } }),
					[agent('lenient', { comments: { min_severity: 'low' } })]
				)
				const report = yield* ReviewService.use(review =>
					review.review(request)
				).pipe(
					Effect.provide(
						reviewLayer(
							run =>
								Effect.succeed(
									finderResult(
										[finding({ severity: 'high', agents: [run.name] })],
										run.name
									)
								),
							() =>
								Effect.succeed({
									status: 'confirmed',
									severity: 'low',
									reason: 'Rare input',
									evidence: ['src/billing/charge.ts:2'],
									model: 'model-b',
								})
						)
					)
				)
				expect(report.bugs).toMatchObject([
					{
						agents: ['reviewer', 'lenient'],
						severity: 'low',
						reportedSeverity: 'high',
						placement: 'inline',
					},
				])
				expect(report.blocking).toBe(true)
			})
	)
	test.effect(
		'global and per-agent nit caps place overflow in summary and never block',
		() =>
			Effect.gen(function* () {
				const request = reviewRequest(
					config({ features: { reviewer: 'off' }, comments: { max_nits: 2 } }),
					[
						agent('style', { kind: 'nit', comments: { max_nits: 1 } }),
						agent('other', { kind: 'nit' }),
					]
				)
				const report = yield* ReviewService.use(review =>
					review.review(request)
				).pipe(
					Effect.provide(
						reviewLayer(
							run =>
								Effect.succeed(
									finderResult(
										[
											finding({
												kind: 'nit',
												path: `src/${run.name}.ts`,
												agents: [run.name],
												severity: 'high',
												title: `${run.name} convention`,
											}),
											finding({
												kind: 'nit',
												path: `src/${run.name}.ts`,
												agents: [run.name],
												severity: 'low',
												line: 50,
												title: `${run.name} spelling`,
											}),
										],
										run.name
									)
								),
							() => Effect.die('nits must not be validated')
						)
					)
				)
				expect(
					report.nits.filter(nit => nit.placement === 'inline')
				).toHaveLength(2)
				expect(
					report.nits.filter(
						nit => nit.agents.includes('style') && nit.placement === 'inline'
					)
				).toHaveLength(1)
				expect(
					report.nits.filter(nit => nit.placement === 'summary')
				).toHaveLength(2)
				expect(report.blocking).toBe(false)
			})
	)
	test.effect(
		'reviewer models dropped while validating are reported without an endpoint error',
		() =>
			Effect.gen(function* () {
				const request = reviewRequest()
				const dropped = yield* Ref.make<readonly DroppedModel[]>([])
				const droppedAll = request.rules.config.models.reviewer.map(entry => ({
					model: entry.model,
					reason: 'rate limited (429)',
				}))
				const report = yield* ReviewService.use(review =>
					review.review(request)
				).pipe(
					Effect.provide(
						reviewLayer(
							run =>
								Effect.succeed(
									finderResult([finding({ agents: [run.name] })], run.name)
								),
							() =>
								Ref.set(dropped, droppedAll).pipe(
									Effect.as({ status: 'unvalidated', error: 'fixture' })
								),
							Ref.get(dropped)
						)
					)
				)
				expect(report.droppedModels).toEqual(droppedAll)
				expect(report.endpointError).toBeUndefined()
				expect(report.bugs).toHaveLength(1)
			})
	)
	test.effect('report wall time includes time already spent planning', () =>
		Effect.gen(function* () {
			yield* TestClock.adjust(1234)
			const report = yield* ReviewService.use(review =>
				review.review(reviewRequest())
			).pipe(
				Effect.provide(
					reviewLayer(
						() => Effect.succeed(finderResult([])),
						() => Effect.die('no findings')
					)
				)
			)
			expect(report.wallMillis).toBe(1234)
			expect(report.blocking).toBe(false)
		})
	)
})
