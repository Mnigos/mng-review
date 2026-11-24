import { type AnswerEntry, toRiskDescription } from '@mng-review/domain'
import {
	AnswerReadService,
	type AnswerRequest,
	type FullRiskInput,
	type OwnedIdentities,
	type RatingBlock,
	RiskFinishService,
	type RiskResult,
	type RiskRun,
	RiskStartService,
	type RiskTarget,
} from '@mng-review/github'
import { Context, Effect, FileSystem, Layer } from 'effect'
import { RISK_DESCRIPTION_OUTPUT } from '../infrastructure/risk-run.config'
import {
	outputPathConfig,
	writeOutputs,
} from '../infrastructure/runner-output.client'
import type { RiskGate } from './risk-gate.helper'

/** What the rating did in a publish run, for the job summary and the result file. */
export type RiskReport =
	| { readonly status: 'off' }
	| { readonly status: 'refused'; readonly reason: string }
	| { readonly status: 'failed'; readonly reason: string }
	| { readonly status: 'none' }
	| { readonly status: 'written'; readonly result: RiskResult }

/** A full run's publish, handed the rating block step 1 decided. */
export type RatedPublish<TValue, TError, TContext> = (
	rating: RatingBlock | undefined
) => Effect.Effect<TValue, TError, TContext>

/** The publish's value, unset when step 1 failed and nothing was published, and what the rating did. */
export interface RatedValue<TValue> {
	readonly value: TValue | undefined
	readonly risk: RiskReport
}

/** The gate's report when the run does not rate, or `undefined` when it does. */
function toSkipped(gate: RiskGate): RiskReport | undefined {
	return gate.status === 'on' ? undefined : gate
}

/**
 * The rating around a publish. A full run reads the held level and writes step 1 before the
 * review is posted, hands the review its rating block, then finishes (marker, label, re-read,
 * grant last); a failed publish revokes. A thread run rates after its posts and only ever raises
 * to High. A failed read or write before or in step 1 publishes nothing and is a `failed` report,
 * which fails the job.
 */
export class RiskRunService extends Context.Service<
	RiskRunService,
	{
		readonly rateFull: <TValue, TError, TContext>(
			gate: RiskGate,
			input: FullRiskInput,
			publish: RatedPublish<TValue, TError, TContext>
		) => Effect.Effect<RatedValue<TValue>, TError, TContext | OwnedIdentities>
		readonly rateThread: (
			gate: RiskGate,
			target: RiskTarget
		) => Effect.Effect<RiskReport, never, OwnedIdentities>
		/**
		 * The entry a review carries for the commands it answers; none when the run does not rate. A
		 * failed read names none, so those commands keep holding until a later answer names them.
		 */
		readonly readAnswers: (
			gate: RiskGate,
			request: AnswerRequest
		) => Effect.Effect<readonly AnswerEntry[], never, OwnedIdentities>
	}
>()('mng-review/RiskRunService') {}

export const RiskRunServiceLive = Layer.effect(
	RiskRunService,
	Effect.gen(function* () {
		const starts = yield* RiskStartService
		const finishes = yield* RiskFinishService
		const answers = yield* AnswerReadService
		const fs = yield* FileSystem.FileSystem

		/** Hands step 1's description to the cleanup step, which writes the same `error` again. */
		const recordStepOne = Effect.fn('RiskRunService.recordStepOne')(function* (
			run: RiskRun
		) {
			const path = yield* outputPathConfig.pipe(
				Effect.orElseSucceed(() => undefined)
			)
			yield* writeOutputs(path, {
				[RISK_DESCRIPTION_OUTPUT]: toRiskDescription(run.description),
			}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.ignore)
		})

		const rateFull = <TValue, TError, TContext>(
			gate: RiskGate,
			input: FullRiskInput,
			publish: RatedPublish<TValue, TError, TContext>
		) =>
			Effect.gen(function* () {
				const skipped = toSkipped(gate)
				if (skipped) return { value: yield* publish(undefined), risk: skipped }
				const started = yield* starts.startFull(input).pipe(Effect.result)
				if (started._tag === 'Failure')
					return {
						value: undefined,
						risk: { status: 'failed', reason: started.failure.message },
					} satisfies RatedValue<TValue>
				const run = started.success
				yield* recordStepOne(run)
				const value = yield* publish(run.block).pipe(
					Effect.tapError(() => finishes.revoke(run))
				)
				const result = yield* finishes.finish(run)
				return {
					value,
					risk: { status: 'written', result },
				} satisfies RatedValue<TValue>
			})

		const rateThread = Effect.fn('RiskRunService.rateThread')(function* (
			gate: RiskGate,
			target: RiskTarget
		) {
			const skipped = toSkipped(gate)
			if (skipped) return skipped
			const started = yield* starts.startThread(target).pipe(Effect.result)
			if (started._tag === 'Failure')
				return {
					status: 'failed',
					reason: started.failure.message,
				} satisfies RiskReport
			if (started.success.status === 'none')
				return { status: 'none' } satisfies RiskReport
			const { run } = started.success
			yield* recordStepOne(run)
			const result = yield* finishes.finish(run)
			return { status: 'written', result } satisfies RiskReport
		})

		const readAnswers = Effect.fn('RiskRunService.readAnswers')(function* (
			gate: RiskGate,
			request: AnswerRequest
		) {
			if (gate.status !== 'on') return []
			const entry = yield* answers
				.getCommandEntry(request)
				.pipe(Effect.orElseSucceed(() => undefined))
			return entry ? [entry] : []
		})

		return { rateFull, rateThread, readAnswers }
	})
)
