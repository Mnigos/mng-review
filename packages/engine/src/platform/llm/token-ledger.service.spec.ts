import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { Response } from 'effect/ai'
import { TokenLedger, TokenLedgerLive } from './token-ledger.service'

const USAGE = new Response.Usage({
	inputTokens: { total: 100, cacheRead: 70 },
	outputTokens: { total: 20, reasoning: 5 },
})

layer(Layer.empty)('TokenLedger', test => {
	test.effect('starts with independent empty model and source totals', () =>
		Effect.gen(function* () {
			const ledger = yield* TokenLedger
			expect(yield* ledger.snapshot).toEqual({})
			expect(yield* ledger.sources).toEqual({})
		}).pipe(Effect.provide(TokenLedgerLive))
	)
	test.effect(
		'adds cache-read input without double counting it in total usage',
		() =>
			Effect.gen(function* () {
				const ledger = yield* TokenLedger
				yield* ledger.record('model-a', USAGE)
				yield* ledger.record('model-a', USAGE)
				expect(yield* ledger.snapshot).toEqual({
					'model-a': {
						calls: 2,
						inputTokens: 200,
						cachedInputTokens: 140,
						outputTokens: 40,
						reasoningTokens: 10,
						totalTokens: 240,
					},
				})
				expect(yield* ledger.sources).toEqual({})
			}).pipe(Effect.provide(TokenLedgerLive))
	)
	test.effect(
		'aggregates several conversations and keeps sources separate from model totals',
		() =>
			Effect.gen(function* () {
				const ledger = yield* TokenLedger
				yield* ledger.recordTurn('reviewer', {
					usage: USAGE,
					firstMessageTokens: 100,
					first: true,
				})
				yield* ledger.recordTurn('reviewer', {
					usage: new Response.Usage({
						inputTokens: { total: 150 },
						outputTokens: { total: 10 },
					}),
					firstMessageTokens: 100,
					first: false,
				})
				yield* ledger.recordTurn('reviewer', {
					usage: USAGE,
					firstMessageTokens: 100,
					first: true,
				})
				yield* ledger.recordTurn('validator', {
					usage: USAGE,
					firstMessageTokens: 100,
					first: true,
				})
				expect(yield* ledger.sources).toMatchObject({
					reviewer: {
						conversations: 2,
						calls: 3,
						inputTokens: 350,
						firstMessageTokens: 300,
						historyTokens: 50,
						cachedInputTokens: 140,
						outputTokens: 50,
						totalTokens: 400,
					},
					validator: {
						conversations: 1,
						calls: 1,
						firstMessageTokens: 100,
						historyTokens: 0,
					},
				})
				expect(yield* ledger.snapshot).toEqual({})
			}).pipe(Effect.provide(TokenLedgerLive))
	)
	test.effect(
		'missing usage counts add zero while still counting the call',
		() =>
			Effect.gen(function* () {
				const ledger = yield* TokenLedger
				yield* ledger.record(
					'model-a',
					new Response.Usage({ inputTokens: {}, outputTokens: {} })
				)
				expect(yield* ledger.snapshot).toEqual({
					'model-a': {
						calls: 1,
						inputTokens: 0,
						cachedInputTokens: 0,
						outputTokens: 0,
						reasoningTokens: 0,
						totalTokens: 0,
					},
				})
			}).pipe(Effect.provide(TokenLedgerLive))
	)
})
