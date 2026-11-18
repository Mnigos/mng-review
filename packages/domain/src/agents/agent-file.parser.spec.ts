import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { ConfigError } from '../config/config.errors'
import {
	parseAgentFile,
	parseFrontMatter,
	splitFrontMatter,
} from './agent-file.parser'
import {
	DEFAULT_AGENT_INPUT,
	DEFAULT_MAX_FINDINGS,
	RESERVED_AGENT_NAMES,
} from './agent.constants'

layer(Layer.empty)('agent file parsing', test => {
	for (const text of [
		'---\nkind: bug\n---\nInstructions',
		'\uFEFF---\r\nkind: bug\r\n---\r\nInstructions',
		'--- \t\nkind: bug\n--- \t\nInstructions',
	])
		test.effect(`splits complete front matter ${JSON.stringify(text)}`, () =>
			Effect.gen(function* () {
				expect(yield* splitFrontMatter(text, 'auth.md')).toEqual({
					yaml: 'kind: bug',
					body: 'Instructions',
				})
			})
		)

	test.effect('splits empty front matter', () =>
		Effect.gen(function* () {
			expect(yield* splitFrontMatter('---\n---\nBody', 'auth.md')).toEqual({
				yaml: '',
				body: 'Body',
			})
		})
	)

	test.effect('closes empty front matter at the first --- line', () =>
		Effect.gen(function* () {
			expect(
				yield* splitFrontMatter('---\n---\nBody\n---\nAfter', 'auth.md')
			).toEqual({ yaml: '', body: 'Body\n---\nAfter' })
		})
	)

	for (const text of [
		'Instructions',
		'---\nkind: bug\nInstructions',
		'\n---\nkind: bug\n---',
		'---\nkind: bug---\nX',
		'---\nkind: bug\n---extra\nX',
	])
		test.effect(
			`requires complete separate delimiter lines ${JSON.stringify(text)}`,
			() =>
				Effect.gen(function* () {
					const error = yield* Effect.flip(splitFrontMatter(text, 'auth.md'))
					expect(error).toBeInstanceOf(ConfigError)
					expect(error.message).toContain('auth.md: missing YAML front matter')
				})
		)

	test.effect(
		'defaults input, maximum findings, needs and all selection lists',
		() =>
			Effect.gen(function* () {
				expect(yield* parseFrontMatter('kind: bug', 'auth.md')).toEqual({
					kind: 'bug',
					input: DEFAULT_AGENT_INPUT,
					max_findings: DEFAULT_MAX_FINDINGS,
					needs: [],
					when: {
						paths: [],
						exclude: [],
						labels: [],
						authors: [],
						targets: [],
					},
				})
				expect(
					(yield* parseFrontMatter(
						'kind: nit\nwhen: {paths: [src/**]}',
						'auth.md'
					)).when
				).toEqual({
					paths: ['src/**'],
					exclude: [],
					labels: [],
					authors: [],
					targets: [],
				})
			})
	)

	for (const [yaml, path] of [
		['kind: style', 'kind'],
		['kind: bug\ninput: patch', 'input'],
		['kind: bug\neffort: extreme', 'effort'],
		['kind: bug\nunknown: true', 'unknown'],
		['kind: bug\nwhen: {unknown: []}', 'when.unknown'],
		['kind: bug\ncomments: {max_nit: 1}', 'comments.max_nit'],
		['kind: bug\nlimits: {concurrency: 2}', 'limits'],
		['kind: bug\nmax_findings: 0', 'max_findings'],
		['kind: bug\nneeds: ci', 'needs'],
		['', 'kind'],
		['kind: bug\nlimits: {max_file_kb: 12}', 'limits'],
	] as const)
		test.effect(`rejects invalid front matter ${yaml}`, () =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(parseFrontMatter(yaml, 'auth.md'))
				expect(error).toBeInstanceOf(ConfigError)
				expect(error.source).toBe('auth.md')
				expect(error.reason).toContain(path)
				if (path === 'limits') expect(error.reason).toBe('unknown key "limits"')
			})
		)

	test.effect('front matter YAML errors name the source', () =>
		Effect.gen(function* () {
			expect(
				(yield* Effect.flip(parseFrontMatter('kind: [', 'auth.md'))).message
			).toContain('auth.md: invalid YAML')
		})
	)

	for (const name of RESERVED_AGENT_NAMES)
		test.effect(`reserves ${name}`, () =>
			Effect.gen(function* () {
				expect(
					(yield* Effect.flip(
						parseAgentFile(name, '---\nkind: bug\n---\nCheck.')
					)).reason
				).toContain('reserved')
			})
		)

	for (const name of [
		'Auth',
		'bad_name',
		'-auth',
		'../auth',
		'auth/name',
		'',
		'auth name',
	])
		test.effect(`rejects invalid name ${JSON.stringify(name)}`, () =>
			Effect.gen(function* () {
				expect(
					(yield* Effect.flip(
						parseAgentFile(name, '---\nkind: bug\n---\nCheck.')
					)).reason
				).toContain('agent names')
			})
		)

	test.effect(
		'uses name or explicit title and leaves body and imports unexpanded',
		() =>
			Effect.gen(function* () {
				expect(
					yield* parseAgentFile(
						'auth',
						'---\nkind: bug\n---\n Check. \n@/docs/auth.md\n'
					)
				).toMatchObject({
					name: 'auth',
					title: 'auth',
					file: '.mng/agents/auth.md',
					body: ' Check. \n@/docs/auth.md\n',
				})
				expect(
					yield* parseAgentFile(
						'auth',
						'---\nkind: bug\ntitle: Ownership\n---\nCheck.',
						'rules/auth.md'
					)
				).toMatchObject({ title: 'Ownership', file: 'rules/auth.md' })
			})
	)
})
