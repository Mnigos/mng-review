import { layer } from '@effect/vitest'
import { Effect, Layer, Ref } from 'effect'
import {
	getMissingTokens,
	isOutOfTokens,
	makeConversationBudget,
	makeTokenPool,
	toAffordableOutputs,
	toEstimatedTokens,
} from './loop-budget.helper'
import { CHARS_PER_TOKEN } from './review.constants'

const BUDGET = { runTokens: 1000, conversationTokens: 100 } as const

describe('loop budgets', () => {
	for (const [spentTokens, nextInputTokens, expected] of [
		[19, 40, false],
		[20, 40, true],
		[21, 40, true],
		[0, 50, true],
		[0, 51, true],
		[0, 49, false],
	] as const)
		test(`${spentTokens} spent plus twice ${nextInputTokens} input ${expected ? 'reaches' : 'fits'} the share`, () =>
			expect(isOutOfTokens(BUDGET, { spentTokens, nextInputTokens })).toBe(
				expected
			))
	test('an absent conversation budget does not force wrap-up', () =>
		expect(
			isOutOfTokens(undefined, { spentTokens: 1000, nextInputTokens: 1000 })
		).toBe(false))
	for (const chars of [0, 1, CHARS_PER_TOKEN, CHARS_PER_TOKEN + 1])
		test(`estimates ${chars} characters with upward rounding`, () =>
			expect(toEstimatedTokens('x'.repeat(chars))).toBe(
				Math.ceil(chars / CHARS_PER_TOKEN)
			))
})

describe('affordable tool outputs', () => {
	const refusal = 'budget reached'
	const state = { spentTokens: 40, nextInputTokens: 50 }
	const output = 'x'.repeat(CHARS_PER_TOKEN * 6)

	test('without a budget preserves every output in order without mutating the input', () => {
		const outputs = Object.freeze([output, output, 'last'])
		expect(toAffordableOutputs(outputs, undefined, state, refusal)).toEqual(
			outputs
		)
		expect(outputs).toEqual([output, output, 'last'])
	})
	test('keeps outputs that exactly fill the space left after spent and next input', () =>
		expect(
			toAffordableOutputs(
				[output, 'y'.repeat(CHARS_PER_TOKEN * 4)],
				BUDGET,
				state,
				refusal
			)
		).toEqual([output, 'y'.repeat(CHARS_PER_TOKEN * 4)]))
	test('refuses outputs beyond the remaining room in their original positions', () =>
		expect(
			toAffordableOutputs([output, output, output], BUDGET, state, refusal)
		).toEqual([output, refusal, refusal]))
	test('rounds each output up before deciding if it fits', () =>
		expect(
			toAffordableOutputs(
				['x', 'y'],
				BUDGET,
				{ spentTokens: 49, nextInputTokens: 50 },
				refusal
			)
		).toEqual(['x', refusal]))
	for (const spentTokens of [50, 51])
		test(`refuses nonempty outputs when remaining room is ${50 - spentTokens}`, () =>
			expect(
				toAffordableOutputs(
					['x', output],
					BUDGET,
					{ spentTokens, nextInputTokens: 50 },
					refusal
				)
			).toEqual([refusal, refusal]))
	test('an empty batch stays empty even when the budget is exhausted', () =>
		expect(
			toAffordableOutputs(
				[],
				BUDGET,
				{ spentTokens: 100, nextInputTokens: 100 },
				refusal
			)
		).toEqual([]))
})

describe('missing conversation tokens', () => {
	test.each([
		[19, 40, 0],
		[20, 40, 1],
		[21, 40, 2],
		[100, 0, 1],
	])(
		'%i spent and %i next input need %i more tokens',
		(spentTokens, nextInputTokens, missing) =>
			expect(getMissingTokens(BUDGET, { spentTokens, nextInputTokens })).toBe(
				missing
			)
	)
})

layer(Layer.empty)('returned finder tokens', test => {
	test.effect(
		'releases only floored positive tokens and claims all or nothing',
		() =>
			Effect.gen(function* () {
				const pool = yield* makeTokenPool
				expect(yield* pool.available).toBe(0)
				for (const tokens of [-10, 0, 0.9]) yield* pool.release(tokens)
				expect(yield* pool.available).toBe(0)
				yield* pool.release(10.9)
				expect(yield* pool.claim(11)).toBe(false)
				expect(yield* pool.available).toBe(10)
				expect(yield* pool.claim(4)).toBe(true)
				expect(yield* pool.available).toBe(6)
				yield* pool.release(-100)
				expect(yield* pool.claim(6)).toBe(true)
				expect(yield* pool.claim(1)).toBe(false)
				expect(yield* pool.available).toBe(0)
			})
	)
	test.effect(
		'concurrent claims cannot spend the same released tokens twice',
		() =>
			Effect.gen(function* () {
				const pool = yield* makeTokenPool
				yield* pool.release(10)
				expect(
					(yield* Effect.all([pool.claim(10), pool.claim(10)], {
						concurrency: 'unbounded',
					})).filter(Boolean)
				).toHaveLength(1)
				expect(yield* pool.available).toBe(0)
			})
	)
	test.effect(
		'claims exactly what is missing, keeps the grant and wraps up when the pool is empty',
		() =>
			Effect.gen(function* () {
				const pool = yield* makeTokenPool
				const budget = yield* makeConversationBudget(
					{ ...BUDGET, pool },
					Effect.succeed(0)
				)
				const state = { spentTokens: 20, nextInputTokens: 40 }
				expect(yield* budget.isSpent(state)).toBe(true)
				yield* pool.release(5)
				expect(yield* budget.isSpent(state)).toBe(false)
				expect(yield* budget.current).toMatchObject({ conversationTokens: 101 })
				expect(yield* pool.available).toBe(4)
				expect(yield* budget.isSpent(state)).toBe(false)
				expect(yield* pool.available).toBe(4)
				expect(yield* budget.isSpent({ ...state, spentTokens: 24 })).toBe(false)
				expect(yield* pool.available).toBe(0)
				expect(yield* budget.current).toMatchObject({ conversationTokens: 105 })
				expect(yield* budget.isSpent({ ...state, spentTokens: 25 })).toBe(true)
			})
	)
	test.effect(
		'an insufficient pool is unchanged and an agent without a pool wraps up',
		() =>
			Effect.gen(function* () {
				const pool = yield* makeTokenPool
				yield* pool.release(2)
				const reviewer = yield* makeConversationBudget(
					{ ...BUDGET, pool },
					Effect.succeed(0)
				)
				const agent = yield* makeConversationBudget(BUDGET, Effect.succeed(0))
				const state = { spentTokens: 23, nextInputTokens: 40 }
				expect(yield* reviewer.isSpent(state)).toBe(true)
				expect(yield* agent.isSpent(state)).toBe(true)
				expect(yield* reviewer.current).toMatchObject({
					conversationTokens: 100,
				})
				expect(yield* pool.available).toBe(2)
			})
	)
	test.effect(
		'the run limit wins over an available pool, including at the exact boundary',
		() =>
			Effect.gen(function* () {
				const pool = yield* makeTokenPool
				yield* pool.release(1000)
				const spent = yield* Ref.make(BUDGET.runTokens - 1)
				const budget = yield* makeConversationBudget(
					{ ...BUDGET, pool },
					Ref.get(spent)
				)
				const state = { spentTokens: 0, nextInputTokens: 1 }
				expect(yield* budget.isSpent(state)).toBe(false)
				yield* Ref.set(spent, BUDGET.runTokens)
				expect(yield* budget.isSpent(state)).toBe(true)
				expect(yield* pool.available).toBe(1000)
			})
	)
	test.effect(
		'an absent budget stays unbounded even after the run has spent tokens',
		() =>
			Effect.gen(function* () {
				const budget = yield* makeConversationBudget(
					undefined,
					Effect.succeed(10_000)
				)
				expect(yield* budget.current).toBeUndefined()
				expect(
					yield* budget.isSpent({
						spentTokens: 10_000,
						nextInputTokens: 10_000,
					})
				).toBe(false)
			})
	)
})

layer(Layer.empty)('coverage token reserve', test => {
	test.effect(
		'holds the reserve until continuation, opens it only once and keeps pool grants',
		() =>
			Effect.gen(function* () {
				const pool = yield* makeTokenPool
				yield* pool.release(10)
				const budget = yield* makeConversationBudget(
					{ ...BUDGET, reserve: 25, pool },
					Effect.succeed(0)
				)
				expect(yield* budget.current).toMatchObject({ conversationTokens: 75 })
				expect(
					yield* budget.isSpent({ spentTokens: 5, nextInputTokens: 35 })
				).toBe(false)
				expect(yield* budget.current).toMatchObject({ conversationTokens: 76 })
				expect(yield* pool.available).toBe(9)
				yield* budget.openReserve
				expect(yield* budget.current).toMatchObject({ conversationTokens: 101 })
				yield* budget.openReserve
				expect(yield* budget.current).toMatchObject({ conversationTokens: 101 })
				expect(
					yield* budget.isSpent({ spentTokens: 20, nextInputTokens: 40 })
				).toBe(false)
				expect(yield* pool.available).toBe(9)
			})
	)
	test.effect(
		'a conversation that is spent can continue with the opened reserve',
		() =>
			Effect.gen(function* () {
				const budget = yield* makeConversationBudget(
					{ ...BUDGET, reserve: 25 },
					Effect.succeed(0)
				)
				const state = { spentTokens: 5, nextInputTokens: 35 }
				expect(yield* budget.isSpent(state)).toBe(true)
				yield* budget.openReserve
				expect(yield* budget.isSpent(state)).toBe(false)
			})
	)
	test.effect('opening a reserve cannot bypass the finder run limit', () =>
		Effect.gen(function* () {
			const budget = yield* makeConversationBudget(
				{ ...BUDGET, reserve: 25 },
				Effect.succeed(BUDGET.runTokens)
			)
			yield* budget.openReserve
			expect(
				yield* budget.isSpent({ spentTokens: 0, nextInputTokens: 1 })
			).toBe(true)
		})
	)
})

layer(Layer.empty)('settled coverage reserve', test => {
	for (const opened of [false, true])
		test.effect(
			`refund includes the ${opened ? 'opened' : 'unopened'} reserve and pool grants`,
			() =>
				Effect.gen(function* () {
					const pool = yield* makeTokenPool
					yield* pool.release(10)
					const budget = yield* makeConversationBudget(
						{ ...BUDGET, reserve: 25, pool },
						Effect.succeed(0)
					)
					yield* budget.record(5)
					expect(
						yield* budget.isSpent({ spentTokens: 5, nextInputTokens: 35 })
					).toBe(false)
					yield* budget.record(7)
					if (opened) yield* budget.openReserve
					expect(yield* budget.current).toMatchObject({
						conversationTokens: opened ? 101 : 76,
					})
					expect(
						yield* budget.settle({ spentTokens: 5, unspentTokens: 0 })
					).toEqual({
						spentTokens: 12,
						unspentTokens: 89,
					})
					expect(yield* pool.available).toBe(9)
				})
		)
})
