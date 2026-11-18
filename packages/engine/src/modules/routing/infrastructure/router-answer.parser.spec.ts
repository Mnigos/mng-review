import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { parseRouterAnswer, stripOuterFence } from './router-answer.parser'

const ANSWER = {
	risk: 'risky',
	add: [{ agent: 'auth', reason: 'checks `ownership` and ``` snippets' }],
} as const
const CANDIDATES = [{ name: 'auth' }, { name: 'billing' }] as const

layer(Layer.empty)('parseRouterAnswer', test => {
	for (const text of [
		JSON.stringify(ANSWER),
		`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``,
		`\`\`\`\n${JSON.stringify(ANSWER)}\n\`\`\``,
		`~~~json\n${JSON.stringify(ANSWER)}\n~~~`,
	])
		test.effect(`accepts JSON with only its outer fence removed: ${text}`, () =>
			Effect.gen(function* () {
				expect(yield* parseRouterAnswer(undefined, text, CANDIDATES)).toEqual({
					status: 'ok',
					risk: 'risky',
					added: ANSWER.add,
				})
			})
		)
	test.effect(
		'prefers route arguments to unrelated text; filters unknown, duplicate and blank additions',
		() =>
			Effect.gen(function* () {
				expect(
					yield* parseRouterAnswer(
						{
							risk: 'normal',
							add: [
								{ agent: 'unknown', reason: 'unknown' },
								{ agent: 'auth', reason: '  ' },
								{ agent: 'auth', reason: '  first valid reason  ' },
								{ agent: 'auth', reason: 'duplicate' },
								{ agent: 'billing', reason: '' },
							],
						},
						'not JSON',
						CANDIDATES
					)
				).toEqual({
					status: 'ok',
					risk: 'normal',
					added: [{ agent: 'auth', reason: 'first valid reason' }],
				})
				expect(
					yield* parseRouterAnswer(undefined, '{"risk":"normal"}', [])
				).toEqual({ status: 'ok', risk: 'normal', added: [] })
			})
	)
	for (const text of [
		'{"risk":"extreme","add":[]}',
		'{bad JSON',
		'',
		'{"add":[]}',
		'{"risk":"normal","add":[{"agent":3,"reason":"x"}]}',
	])
		test.effect(`rejects malformed answer ${text}`, () =>
			Effect.gen(function* () {
				expect(
					yield* parseRouterAnswer(undefined, text, CANDIDATES).pipe(
						Effect.flip
					)
				).toMatchObject({ _tag: 'RouterAnswerError' })
			})
		)
	test.effect('malformed route params fail even when text is valid', () =>
		Effect.gen(function* () {
			expect(
				yield* parseRouterAnswer(
					{ risk: 'extreme' },
					JSON.stringify(ANSWER),
					CANDIDATES
				).pipe(Effect.flip)
			).toMatchObject({ _tag: 'RouterAnswerError' })
		})
	)
})

test('leaves internal fences untouched and does not remove prose around JSON', () => {
	expect(stripOuterFence(JSON.stringify(ANSWER))).toBe(JSON.stringify(ANSWER))
	expect(stripOuterFence('before\n```json\n{}\n```')).toBe(
		'before\n```json\n{}\n```'
	)
})
