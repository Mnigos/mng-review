import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires shared GitHub reply fixtures.
import {
	pendingBotThread,
	pendingReply,
} from '../../../../packages/github/src/shared/mocks/thread-reply-test.helper'
import type { PreparedRun } from '../application/shadow-run.types'
import { EVENT, recheckProposals } from '../shared/mocks/outcome-file.helper'
import { parsePreparedRun, PREPARED_PATH_VARIABLE } from './prepared-run.parser'

const PREPARED = [
	{
		status: 'ready',
		event: EVENT,
		threads: recheckProposals().rejected.map(entry => entry.thread),
		prior: { runs: 2, head: EVENT.baseSha },
	},
	{ status: 'ready', event: EVENT, threads: [] },
	{ status: 'skipped', reason: 'unsupported event' },
	{ status: 'skipped', reason: 'draft', event: EVENT },
	{ status: 'invalid-config', source: '.mng/review.yml', reason: 'invalid' },
	{
		status: 'invalid-config',
		source: '.mng/review.yml',
		reason: 'invalid',
		event: EVENT,
	},
	{ status: 'failed', reason: 'missing git object', event: EVENT },
] as const satisfies readonly PreparedRun[]

layer(Layer.empty)('parsePreparedRun', test => {
	test.effect(
		'preserves reply digests and the closing commit through the prepared file',
		() =>
			Effect.gen(function* () {
				const prepared = {
					status: 'ready',
					event: EVENT,
					threads: [pendingBotThread({ closedAt: EVENT.headSha })],
					replies: [pendingReply()],
				} as const satisfies PreparedRun
				expect(yield* parsePreparedRun(JSON.stringify(prepared))).toEqual(
					prepared
				)
			})
	)
	test.effect('rejects a prepared reply without a digest', () =>
		Effect.gen(function* () {
			const { digest: _digest, ...reply } = pendingReply()
			const error = yield* parsePreparedRun(
				JSON.stringify({
					status: 'ready',
					event: EVENT,
					threads: [pendingBotThread()],
					replies: [reply],
				})
			).pipe(Effect.flip)
			expect(error).toMatchObject({
				_tag: 'ConfigError',
				source: PREPARED_PATH_VARIABLE,
			})
			expect(error.reason).toContain('digest')
		})
	)
	for (const [index, prepared] of PREPARED.entries())
		test.effect(`round-trips ${prepared.status} fixture ${index}`, () =>
			Effect.gen(function* () {
				expect(yield* parsePreparedRun(JSON.stringify(prepared))).toEqual(
					prepared
				)
			})
		)
	test.effect(
		'restores unknown thread coordinates and commit as undefined',
		() =>
			Effect.gen(function* () {
				const thread = recheckProposals().rejected[0]?.thread
				expect(thread).toBeDefined()
				const prepared = yield* parsePreparedRun(
					JSON.stringify({
						status: 'ready',
						event: EVENT,
						threads: [
							{
								...thread,
								line: undefined,
								originalLine: undefined,
								commit: undefined,
							},
						],
					})
				)
				expect(prepared).toMatchObject({
					threads: [
						{ line: undefined, originalLine: undefined, commit: undefined },
					],
				})
			})
	)
	for (const value of [
		{ status: 'unknown' },
		{
			status: 'ready',
			event: EVENT,
			threads: [
				{ ...recheckProposals().rejected[0]?.thread, marker: { v: 99 } },
			],
		},
	])
		test.effect(`rejects ${JSON.stringify(value)}`, () =>
			Effect.gen(function* () {
				expect(
					yield* parsePreparedRun(JSON.stringify(value)).pipe(Effect.flip)
				).toMatchObject({ _tag: 'ConfigError', source: PREPARED_PATH_VARIABLE })
			})
		)
	test.effect('rejects malformed JSON', () =>
		Effect.gen(function* () {
			expect(yield* parsePreparedRun('{').pipe(Effect.flip)).toMatchObject({
				_tag: 'ConfigError',
				source: PREPARED_PATH_VARIABLE,
			})
		})
	)
})
