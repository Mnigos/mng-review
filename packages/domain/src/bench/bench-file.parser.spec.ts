import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { ConfigError } from '../config/config.errors'
import { parseBenchFile } from './bench-file.parser'
import { BENCH_FILE_VERSION, EXPECTED_LABELS } from './bench.constants'

const SOURCE = 'fixtures/bench.yml'
const ENTRY = {
	id: 'duplicate-charge',
	path: 'src/billing/charge.ts',
	line: 81,
	label: 'real',
	summary: 'A retry charges twice.',
} as const
const CASE = {
	id: 'checkout-timeout',
	base: 'base',
	head: 'head',
	expected: [ENTRY],
} as const
const FILE = { version: BENCH_FILE_VERSION, cases: [CASE] } as const

layer(Layer.empty)('parseBenchFile', test => {
	test.effect('decodes version 1 and defaults labels to an empty list', () =>
		Effect.gen(function* () {
			expect(yield* parseBenchFile(JSON.stringify(FILE), SOURCE)).toEqual({
				...FILE,
				cases: [{ ...CASE, labels: [] }],
			})
		})
	)

	for (const metadata of [
		{ title: 'Fix checkout retries' },
		{ body: 'Retry the charge.\nPreserve idempotency.' },
		{ title: 'Fix checkout retries', body: '' },
	] as const)
		test.effect(
			`preserves optional metadata ${JSON.stringify(metadata)} in version 1`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* parseBenchFile(
							JSON.stringify({ ...FILE, cases: [{ ...CASE, ...metadata }] }),
							SOURCE
						)
					).toEqual({ ...FILE, cases: [{ ...CASE, ...metadata, labels: [] }] })
				})
		)
	for (const key of ['title', 'body'] as const)
		for (const value of [null, false, 123, [], {}])
			test.effect(
				`rejects ${key} type ${JSON.stringify(value)} naming its key`,
				() =>
					Effect.gen(function* () {
						const error = yield* parseBenchFile(
							JSON.stringify({ ...FILE, cases: [{ ...CASE, [key]: value }] }),
							SOURCE
						).pipe(Effect.flip)
						expect(error).toBeInstanceOf(ConfigError)
						expect(error.source).toBe(SOURCE)
						expect(error.reason).toContain(`cases.0.${key}`)
					})
			)
	test.effect('rejects an empty title naming its key', () =>
		Effect.gen(function* () {
			const error = yield* parseBenchFile(
				JSON.stringify({ ...FILE, cases: [{ ...CASE, title: '' }] }),
				SOURCE
			).pipe(Effect.flip)
			expect(error.reason).toContain('cases.0.title')
		})
	)
	for (const label of [...EXPECTED_LABELS, false] as const)
		test.effect(`decodes label ${JSON.stringify(label)}`, () =>
			Effect.gen(function* () {
				const text = `version: ${BENCH_FILE_VERSION}\ncases:\n  - id: checkout-timeout\n    base: base\n    head: head\n    expected:\n      - id: duplicate-charge\n        path: src/billing/charge.ts\n        line: 81\n        label: ${typeof label === 'boolean' ? 'false' : `'${label}'`}\n        summary: A retry charges twice.\n`
				expect(
					(yield* parseBenchFile(text, SOURCE)).cases[0]?.expected[0]?.label
				).toBe(String(label))
			})
		)
	test.effect(
		'allows the same expected id in different cases and preserves labels',
		() =>
			Effect.gen(function* () {
				const cases = [
					{ ...CASE, labels: ['review'] },
					{ ...CASE, id: 'checkout-retry' },
				]
				expect(
					(yield* parseBenchFile(JSON.stringify({ ...FILE, cases }), SOURCE))
						.cases
				).toEqual([cases[0], { ...cases[1], labels: [] }])
			})
	)
	for (const [name, value, path] of [
		['wrong version', { ...FILE, version: 2 }, 'version'],
		['missing version', { cases: [CASE] }, 'version'],
		['unknown root key', { ...FILE, extra: true }, 'extra'],
		[
			'unknown case key',
			{ ...FILE, cases: [{ ...CASE, extra: true }] },
			'cases.0.extra',
		],
		[
			'unknown expected key',
			{ ...FILE, cases: [{ ...CASE, expected: [{ ...ENTRY, extra: true }] }] },
			'cases.0.expected.0.extra',
		],
		[
			'zero line',
			{ ...FILE, cases: [{ ...CASE, expected: [{ ...ENTRY, line: 0 }] }] },
			'cases.0.expected.0.line',
		],
		[
			'fractional line',
			{ ...FILE, cases: [{ ...CASE, expected: [{ ...ENTRY, line: 1.5 }] }] },
			'cases.0.expected.0.line',
		],
		[
			'unknown label',
			{
				...FILE,
				cases: [{ ...CASE, expected: [{ ...ENTRY, label: 'maybe' }] }],
			},
			'cases.0.expected.0.label',
		],
		['duplicate case ids', { ...FILE, cases: [CASE, CASE] }, 'cases'],
		[
			'duplicate expected ids',
			{ ...FILE, cases: [{ ...CASE, expected: [ENTRY, ENTRY] }] },
			'cases.0.expected',
		],
		[
			'missing case base',
			{ ...FILE, cases: [{ id: CASE.id, head: CASE.head, expected: [] }] },
			'cases.0.base',
		],
		[
			'missing entry summary',
			{
				...FILE,
				cases: [
					{
						...CASE,
						expected: [
							{
								id: ENTRY.id,
								path: ENTRY.path,
								line: ENTRY.line,
								label: ENTRY.label,
							},
						],
					},
				],
			},
			'cases.0.expected.0.summary',
		],
	] as const)
		test.effect(`rejects ${name} with its source and key path`, () =>
			Effect.gen(function* () {
				const error = yield* parseBenchFile(JSON.stringify(value), SOURCE).pipe(
					Effect.flip
				)
				expect(error).toBeInstanceOf(ConfigError)
				expect(error.source).toBe(SOURCE)
				expect(error.message).toContain(SOURCE)
				expect(error.reason).toContain(path)
			})
		)
	for (const [name, text, reason] of [
		['empty text', '', 'empty'],
		['comments only', '# benchmark', 'empty'],
		['invalid YAML', 'version: [', 'invalid YAML'],
	] as const)
		test.effect(`rejects ${name} with the file-level error`, () =>
			Effect.gen(function* () {
				const error = yield* parseBenchFile(text, SOURCE).pipe(Effect.flip)
				expect(error).toBeInstanceOf(ConfigError)
				expect(error.source).toBe(SOURCE)
				expect(error.message).toContain(SOURCE)
				expect(error.reason).toContain(reason)
			})
		)
})
