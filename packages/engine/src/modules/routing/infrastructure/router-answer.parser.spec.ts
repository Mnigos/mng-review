import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
	parseRouterAnswer,
	type RouterAnswerContext,
	stripOuterFence,
} from './router-answer.parser'

const ANSWER = {
	add: [{ agent: 'auth', reason: 'checks `ownership` and ``` snippets' }],
	signals: [
		{
			category: 'access',
			path: 'src/auth/session.guard.ts',
			reason: 'Lines 8-12 change the ownership check.',
		},
	],
} as const
const CONTEXT = {
	candidates: [{ name: 'auth' }, { name: 'billing' }],
	paths: ['src/auth/session.guard.ts'],
} as const satisfies RouterAnswerContext

layer(Layer.empty)('parseRouterAnswer', test => {
	for (const text of [
		JSON.stringify(ANSWER),
		`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``,
		`\`\`\`\n${JSON.stringify(ANSWER)}\n\`\`\``,
		`~~~json\n${JSON.stringify(ANSWER)}\n~~~`,
	])
		test.effect(`accepts JSON with only its outer fence removed: ${text}`, () =>
			Effect.gen(function* () {
				expect(yield* parseRouterAnswer(undefined, text, CONTEXT)).toEqual({
					status: 'ok',
					risk: 'risky',
					signals: ANSWER.signals,
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
							add: [
								{ agent: 'unknown', reason: 'unknown' },
								{ agent: 'auth', reason: '  ' },
								{ agent: 'auth', reason: '  first valid reason  ' },
								{ agent: 'auth', reason: 'duplicate' },
								{ agent: 'billing', reason: '' },
							],
						},
						'not JSON',
						CONTEXT
					)
				).toEqual({
					status: 'ok',
					risk: 'normal',
					signals: [],
					added: [{ agent: 'auth', reason: 'first valid reason' }],
				})
			})
	)
	for (const toolArguments of [undefined, {}])
		test.effect(
			`defaults omitted fields for ${toolArguments === undefined ? 'text' : 'tool arguments'}`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* parseRouterAnswer(toolArguments, '{}', {
							candidates: [],
							paths: [],
						})
					).toEqual({ status: 'ok', risk: 'normal', signals: [], added: [] })
				})
		)
	for (const trivial of [true, false])
		test.effect(
			`derives risk after discarding invalid signals with trivial=${trivial}`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* parseRouterAnswer(
							{
								trivial,
								signals: [
									{ ...ANSWER.signals[0], path: 'src/unchanged.ts' },
									{ ...ANSWER.signals[0], reason: ' \n ' },
								],
							},
							'',
							CONTEXT
						)
					).toEqual({
						status: 'ok',
						risk: trivial ? 'trivial' : 'normal',
						signals: [],
						added: [],
					})
				})
		)
	test.effect(
		'normalises and deduplicates signals before deriving risk, even for a trivial answer',
		() =>
			Effect.gen(function* () {
				const [signal] = ANSWER.signals
				expect(
					yield* parseRouterAnswer(
						{
							trivial: true,
							signals: [
								{
									...signal,
									path: `./${signal.path}`,
									reason: `  ${signal.reason}  `,
								},
								{ ...signal, reason: 'duplicate' },
								{ ...signal, category: 'secrets' },
							],
						},
						'',
						CONTEXT
					)
				).toEqual({
					status: 'ok',
					risk: 'risky',
					signals: [signal, { ...signal, category: 'secrets' }],
					added: [],
				})
			})
	)
	for (const text of [
		'{bad JSON',
		'',
		'{"trivial":"true"}',
		'{"signals":null}',
		'{"signals":[{"category":"unknown","path":"a.ts","reason":"x"}]}',
		'{"signals":[{"category":"access","path":3,"reason":"x"}]}',
		'{"signals":[{"category":"access","path":"a.ts"}]}',
		'{"add":[{"agent":3,"reason":"x"}]}',
	])
		test.effect(`rejects malformed answer ${text}`, () =>
			Effect.gen(function* () {
				expect(
					yield* parseRouterAnswer(undefined, text, CONTEXT).pipe(Effect.flip)
				).toMatchObject({ _tag: 'RouterAnswerError' })
			})
		)
	test.effect('malformed route params fail even when text is valid', () =>
		Effect.gen(function* () {
			expect(
				yield* parseRouterAnswer(
					{ trivial: 'yes' },
					JSON.stringify(ANSWER),
					CONTEXT
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
