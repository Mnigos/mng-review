import { layer } from '@effect/vitest'
import { Effect, Layer, Ref } from 'effect'
import {
	getMissingTokens,
	getTokenRate,
	isOutOfTokens,
	makeConversationBudget,
	makeTokenPool,
	makeTokenRoom,
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

layer(Layer.empty)('tool output room', test => {
	test.effect('the whole share is open before the first answer', () =>
		Effect.gen(function* () {
			const budget = yield* makeConversationBudget(BUDGET, Effect.succeed(0))
			expect(yield* budget.current).toEqual(BUDGET)
		})
	)
	test.effect(
		'claims from the pool what tool outputs lack before the answer call',
		() =>
			Effect.gen(function* () {
				const pool = yield* makeTokenPool
				yield* pool.release(50)
				const budget = yield* makeConversationBudget(
					{ ...BUDGET, pool },
					Effect.succeed(0)
				)
				const state = { spentTokens: 40, nextInputTokens: 40 }
				yield* budget.claimFor(state, 20)
				expect(yield* budget.current).toMatchObject({ conversationTokens: 100 })
				yield* budget.claimFor(state, 30)
				expect(yield* budget.current).toMatchObject({ conversationTokens: 110 })
				expect(yield* pool.available).toBe(40)
				expect(
					toAffordableOutputs(
						['x'.repeat(CHARS_PER_TOKEN * 30)],
						yield* budget.current,
						state,
						'refused'
					)
				).toEqual(['x'.repeat(CHARS_PER_TOKEN * 30)])
			})
	)
	test.effect('without a pool or a budget it claims nothing', () =>
		Effect.gen(function* () {
			const state = { spentTokens: 40, nextInputTokens: 40 }
			const budget = yield* makeConversationBudget(BUDGET, Effect.succeed(0))
			yield* budget.claimFor(state, 1000)
			expect(yield* budget.current).toEqual(BUDGET)
			const unbounded = yield* makeConversationBudget(
				undefined,
				Effect.succeed(0)
			)
			yield* unbounded.claimFor(state, 1000)
			expect(yield* unbounded.current).toBeUndefined()
		})
	)
})

layer(Layer.empty)('token room', test => {
	test.effect(
		'gives at most what it holds and counts what it could not give',
		() =>
			Effect.gen(function* () {
				const room = yield* makeTokenRoom(500)
				expect(yield* room.take(300)).toBe(300)
				expect(yield* room.take(400)).toBe(200)
				expect(yield* room.take(0)).toBe(0)
				expect(yield* room.taken).toBe(500)
				expect(yield* room.short).toBe(200)
			})
	)
	test.effect('a room under zero gives nothing', () =>
		Effect.gen(function* () {
			const room = yield* makeTokenRoom(-5)
			expect(yield* room.take(10)).toBe(0)
			expect(yield* room.taken).toBe(0)
			expect(yield* room.short).toBe(10)
		})
	)
})

describe('token rate', () => {
	for (const [real, estimate, rate] of [
		[200, 100, 2],
		[50, 100, 0.5],
		[100, 100, 1],
		[7, 0, 1],
	] as const)
		test(`${real} real tokens over an estimate of ${estimate} is a rate of ${rate}`, () =>
			expect(getTokenRate(real, estimate)).toBe(rate))
})

layer(Layer.empty)('conversation token rate', test => {
	const GRANTED = { runTokens: 5000, conversationTokens: 3000, grant: 1000 }
	for (const [real, taken] of [
		[200, 1000],
		[150, 500],
		[100, 0],
		[50, 0],
	] as const)
		test.effect(
			`a first call of ${real} tokens over an estimate of 100 takes ${taken} from the room`,
			() =>
				Effect.gen(function* () {
					const room = yield* makeTokenRoom(10_000)
					const budget = yield* makeConversationBudget(
						{ ...GRANTED, room },
						Effect.succeed(0)
					)
					expect(yield* budget.applyRate(real, 100)).toBe(real / 100)
					expect(yield* budget.current).toEqual({
						...GRANTED,
						room,
						runTokens: GRANTED.runTokens + taken,
						conversationTokens: GRANTED.conversationTokens + taken,
					})
					expect(yield* room.taken).toBe(taken)
					expect(
						yield* budget.settle({ spentTokens: 0, unspentTokens: 0 })
					).toEqual({
						spentTokens: 0,
						unspentTokens: GRANTED.conversationTokens + taken,
						tokenRate: real / 100,
					})
				})
		)
	test.effect('takes no more than the room holds', () =>
		Effect.gen(function* () {
			const room = yield* makeTokenRoom(300)
			const budget = yield* makeConversationBudget(
				{ ...GRANTED, room },
				Effect.succeed(0)
			)
			yield* budget.applyRate(300, 100)
			expect(yield* budget.current).toMatchObject({
				conversationTokens: GRANTED.conversationTokens + 300,
			})
			expect(yield* room.taken).toBe(300)
			expect(yield* room.short).toBe(1700)
			expect(yield* budget.applyRate(900, 100)).toBe(3)
			expect(yield* room.short).toBe(1700)
		})
	)
	test.effect(
		'another conversation taking from the room raises the run stop',
		() =>
			Effect.gen(function* () {
				const room = yield* makeTokenRoom(10_000)
				const budget = yield* makeConversationBudget(
					{ runTokens: 100, conversationTokens: 1000, room },
					Effect.succeed(150)
				)
				const state = { spentTokens: 0, nextInputTokens: 10 }
				expect(yield* budget.isSpent(state)).toBeTruthy()
				yield* room.take(100)
				expect(yield* budget.isSpent(state)).toBe(false)
			})
	)
	test.effect('without a grant or a room the rate takes nothing', () =>
		Effect.gen(function* () {
			const room = yield* makeTokenRoom(10_000)
			const ungranted = yield* makeConversationBudget(
				{ ...BUDGET, room },
				Effect.succeed(0)
			)
			expect(yield* ungranted.applyRate(300, 100)).toBe(3)
			expect(yield* room.taken).toBe(0)
			const roomless = yield* makeConversationBudget(
				{ ...BUDGET, grant: 1000 },
				Effect.succeed(0)
			)
			yield* roomless.applyRate(300, 100)
			expect(yield* roomless.current).toEqual({ ...BUDGET, grant: 1000 })
		})
	)
})
