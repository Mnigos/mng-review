import { layer } from '@effect/vitest'
import { MAX_RECHECKS } from '@mng-review/github'
import { Effect, Layer } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires shared GitHub reply fixtures.
import {
	ACCEPTED_DECISION,
	decidedReply,
} from '../../../../packages/github/src/shared/mocks/thread-reply-test.helper'
import { outcomeFile } from '../shared/mocks/outcome-file.helper'
import { parseOutcomeFile } from './outcome-file.parser'
import { MAX_OUTCOME_BYTES } from './outcome-file.schema'

afterEach(() => vi.restoreAllMocks())

layer(Layer.empty)('parseOutcomeFile', test => {
	test.effect('rejects an outcome accepted decision with empty evidence', () =>
		Effect.gen(function* () {
			const error = yield* parseOutcomeFile(
				JSON.stringify({
					...outcomeFile(),
					replies: {
						decided: [decidedReply({ ...ACCEPTED_DECISION, evidence: [] })],
						tokens: {},
					},
				})
			).pipe(Effect.flip)
			expect(error._tag).toBe('OutcomeFileError')
			expect(error.message).toContain('evidence')
		})
	)
	test.effect(
		'accepts an outcome accepted decision with one evidence entry',
		() =>
			Effect.gen(function* () {
				const file = {
					...outcomeFile(),
					replies: { decided: [decidedReply(ACCEPTED_DECISION)], tokens: {} },
				}
				expect(yield* parseOutcomeFile(JSON.stringify(file))).toEqual(file)
			})
	)

	test.effect('preserves the digest on an outcome reply decision', () =>
		Effect.gen(function* () {
			const file = {
				...outcomeFile(),
				replies: { decided: [decidedReply()], tokens: {} },
			}
			expect(yield* parseOutcomeFile(JSON.stringify(file))).toEqual(file)
		})
	)
	test.effect('rejects an outcome reply decision without a digest', () =>
		Effect.gen(function* () {
			const { digest: _digest, ...decision } = decidedReply()
			const error = yield* parseOutcomeFile(
				JSON.stringify({
					...outcomeFile(),
					replies: { decided: [decision], tokens: {} },
				})
			).pipe(Effect.flip)
			expect(error._tag).toBe('OutcomeFileError')
			expect(error.message).toContain('digest')
		})
	)
	test.effect('decodes a complete version-one outcome', () =>
		Effect.gen(function* () {
			const file = outcomeFile()
			expect(yield* parseOutcomeFile(JSON.stringify(file))).toEqual(file)
		})
	)
	test.effect('rejects version 2', () =>
		Effect.gen(function* () {
			const error = yield* parseOutcomeFile(
				JSON.stringify({ ...outcomeFile(), version: 2 })
			).pipe(Effect.flip)
			expect(error._tag).toBe('OutcomeFileError')
			expect(error.message).toContain('version')
		})
	)
	test.effect('rejects text one byte over the cap before parsing JSON', () =>
		Effect.gen(function* () {
			const parseSpy = vi.spyOn(JSON, 'parse')
			const error = yield* parseOutcomeFile(
				' '.repeat(MAX_OUTCOME_BYTES + 1)
			).pipe(Effect.flip)
			expect(error.message).toContain(`${MAX_OUTCOME_BYTES + 1} bytes`)
			expect(parseSpy).not.toHaveBeenCalled()
			parseSpy.mockRestore()
		})
	)
	test.effect('counts UTF-8 bytes instead of characters', () =>
		Effect.gen(function* () {
			const error = yield* parseOutcomeFile(
				`${'é'.repeat(MAX_OUTCOME_BYTES / 2)} `
			).pipe(Effect.flip)
			expect(error.message).toContain(`${MAX_OUTCOME_BYTES + 1} bytes`)
		})
	)
	test.effect('parses text exactly at the cap and reports invalid JSON', () =>
		Effect.gen(function* () {
			const error = yield* parseOutcomeFile(' '.repeat(MAX_OUTCOME_BYTES)).pipe(
				Effect.flip
			)
			expect(error.message).toContain('the outcome file is invalid:')
		})
	)
	test.effect('reports malformed JSON', () =>
		Effect.gen(function* () {
			const error = yield* parseOutcomeFile('{broken').pipe(Effect.flip)
			expect(error._tag).toBe('OutcomeFileError')
			expect(error.message).toContain('the outcome file is invalid:')
		})
	)
	test.effect('rejects reviewed status without a report', () =>
		Effect.gen(function* () {
			const { report: _report, ...file } = outcomeFile()
			const error = yield* parseOutcomeFile(JSON.stringify(file)).pipe(
				Effect.flip
			)
			expect(error.message).toContain('a reviewed outcome needs its report')
		})
	)
	test.effect(
		'drops title, body, rules and token keys instead of forwarding them',
		() =>
			Effect.gen(function* () {
				const file = outcomeFile()
				const extras = {
					title: 'untrusted title',
					body: 'untrusted body',
					rules: { skip: true },
					token: 'untrusted-token',
					key: 'untrusted-key',
				}
				expect(
					yield* parseOutcomeFile(
						JSON.stringify({
							...file,
							...extras,
							binding: { ...file.binding, ...extras },
						})
					)
				).toEqual(file)
			})
	)
	test.effect('rejects an unknown outcome status', () =>
		Effect.gen(function* () {
			const error = yield* parseOutcomeFile(
				JSON.stringify({ ...outcomeFile(), status: 'unknown' })
			).pipe(Effect.flip)
			expect(error.message).toContain('status')
		})
	)
	test.effect('rejects more than MAX_RECHECKS proposals', () =>
		Effect.gen(function* () {
			const error = yield* parseOutcomeFile(
				JSON.stringify({
					...outcomeFile(),
					recheck: {
						checked: MAX_RECHECKS + 1,
						rejected: Array.from({ length: MAX_RECHECKS + 1 }, () => ({
							threadId: 'thread',
							fingerprint: 'fingerprint',
							reason: 'The write is guarded.',
						})),
						tokens: {},
					},
				})
			).pipe(Effect.flip)
			expect(error.message).toContain('rejected')
		})
	)
})
