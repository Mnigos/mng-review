import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { Yaml } from 'effect/encoding'
import { parseAgentFile } from '../agents/agent-file.parser'
import {
	AGENT_NAME_PATTERN,
	DEFAULT_AGENT_INPUT,
	RESERVED_AGENT_NAMES,
} from '../agents/agent.constants'
import { RENAMED_AGENT_SUFFIX } from './init.constants'
import {
	getAgentKind,
	toAgentName,
	toImportedAgent,
} from './macroscope-agent.helper'
import { parseMacroscopeFile } from './macroscope-file.parser'
import { macroscopeAgentSchema } from './macroscope-file.schema'

/** Imports through the real parser and decodes every generated agent before assertions. */
function importAgent(
	text: string,
	name = 'billing',
	sharedNeeds: readonly string[] = [],
	taken: ReadonlySet<string> = new Set()
) {
	return Effect.gen(function* () {
		const file = { path: `.macroscope/check-run-agents/${name}.md`, text }
		const document = yield* parseMacroscopeFile(macroscopeAgentSchema, file)
		const imported = toImportedAgent({ file, document, sharedNeeds, taken })
		const parsed = yield* parseAgentFile(
			imported.choice.name,
			imported.file.text,
			imported.file.path
		)
		return { imported, parsed }
	})
}

layer(Layer.empty)('Macroscope agent import', test => {
	test.effect(
		'maps title, every selection list and merged unique requirements',
		() =>
			Effect.gen(function* () {
				const { parsed } = yield* importAgent(
					`---
title: Example checks
include: ['src/billing/**']
exclude: ['**/*.spec.ts']
labels: [billing]
authors: [author-a]
targets: [main]
requires: [ci, unit, ci]
---
Check balances.`,
					'billing',
					['unit', 'build', 'build']
				)
				expect(parsed.title).toBe('Example checks')
				expect(parsed.frontMatter).toMatchObject({
					kind: 'bug',
					when: {
						paths: ['src/billing/**'],
						exclude: ['**/*.spec.ts'],
						labels: ['billing'],
						authors: ['author-a'],
						targets: ['main'],
					},
					needs: ['ci', 'unit', 'build'],
				})
			})
	)

	for (const [input, mapped] of [
		['pr_metadata', 'metadata'],
		['incremental', 'incremental'],
		['full_diff', 'full_diff'],
		['code_object', 'full_diff'],
	] as const)
		test.effect(`maps input ${input} to ${mapped}`, () =>
			Effect.gen(function* () {
				const { imported, parsed } = yield* importAgent(
					`---\ninput: ${input}\n---\nCheck balances.`
				)
				expect(parsed.frontMatter.input).toBe(mapped)
				const changed = imported.notes.filter(note => note.kind === 'changed')
				if (input === 'code_object')
					expect(changed.map(note => note.detail).join('\n')).toContain(
						'code_object became full_diff'
					)
				else expect(changed).toEqual([])
			})
		)

	test.effect(
		'drops unknown input with a note and uses the incremental default',
		() =>
			Effect.gen(function* () {
				const { imported, parsed } = yield* importAgent(
					'---\ninput: unknown_input\n---\nCheck balances.'
				)
				expect(parsed.frontMatter.input).toBe(DEFAULT_AGENT_INPUT)
				expect(imported.file.text).not.toContain('input:')
				expect(
					imported.notes.find(note => note.kind === 'dropped')?.detail
				).toContain('input: unknown_input')
			})
	)

	test.effect(
		'drops model, reasoning, all budget keys and unknown keys with notes',
		() =>
			Effect.gen(function* () {
				const { imported } = yield* importAgent(
					'---\nmodel: example-model\nreasoning: high\nmaxRuns: 2\nmaxBudget: 4\nmaxBudgetTokens: 50\nmaxBudgetUsd: 1\ncustom: true\n---\nCheck balances.'
				)
				const yaml = imported.file.text.split('---\n')[1] ?? ''
				expect(Yaml.parse(yaml)).toEqual({ kind: 'bug' })
				for (const key of [
					'model',
					'reasoning',
					'maxRuns',
					'maxBudget',
					'maxBudgetTokens',
					'maxBudgetUsd',
					'custom',
				])
					expect(
						imported.notes.some(
							note => note.kind === 'dropped' && note.detail.includes(key)
						)
					).toBeTruthy()
				expect(imported.notes.map(note => note.detail).join('\n')).toContain(
					'models.agents'
				)
				expect(imported.notes.map(note => note.detail).join('\n')).toContain(
					'limits'
				)
			})
	)

	for (const [title, body, kind, reason] of [
		[
			'Example conventions',
			'Check balances.',
			'nit',
			'title mentions "conventions"',
		],
		[
			'Example checks',
			'Check STYLE and hygiene.',
			'nit',
			'instructions mention "STYLE"',
		],
		[
			undefined,
			'Check balance updates.',
			'bug',
			'no mention of conventions, style or hygiene',
		],
	] as const)
		test.effect(`guesses ${kind} because ${reason}`, () =>
			Effect.gen(function* () {
				expect(getAgentKind('billing', title, body)).toEqual({
					name: 'billing',
					kind,
					reason,
				})
				const { imported, parsed } = yield* importAgent(
					`---\n${title === undefined ? '' : `title: ${title}\n`}---\n${body}`
				)
				expect(parsed.frontMatter.kind).toBe(kind)
				expect(imported.notes).toContainEqual(
					expect.objectContaining({
						kind: 'guessed',
						detail: `kind: ${kind} (${reason})`,
					})
				)
			})
		)

	test.effect('keeps body whitespace and import lines byte for byte', () =>
		Effect.gen(function* () {
			const body =
				'  Check balances.  \n\n@/docs/billing.md#Rules\n\t@/docs/other.md\n\n'
			const { imported, parsed } = yield* importAgent(
				`---\ntitle: Example checks\n---\n${body}`
			)
			expect(
				imported.file.text.slice(imported.file.text.indexOf('\n---\n') + 5)
			).toBe(body)
			expect(parsed.body).toBe(body)
		})
	)

	for (const name of [...RESERVED_AGENT_NAMES, 'Bad_Name', '---', '!!!'])
		test.effect(`generates a decodable unique agent for ${name}`, () =>
			Effect.gen(function* () {
				const { imported, parsed } = yield* importAgent('Check balances.', name)
				expect(AGENT_NAME_PATTERN.test(parsed.name)).toBeTruthy()
				expect(RESERVED_AGENT_NAMES).not.toContain(parsed.name)
				expect(
					imported.notes.find(note => note.kind === 'changed')?.detail
				).toContain(`written as ${parsed.name}.md`)
				if (RESERVED_AGENT_NAMES.some(reserved => reserved === name))
					expect(parsed.name).toBe(`${name}-${RENAMED_AGENT_SUFFIX}`)
			})
		)

	test.effect(
		'adds a suffix for each collision without taking another occupied name',
		() =>
			Effect.gen(function* () {
				const taken = new Set(['billing', 'billing-2', 'billing-3'])
				const { parsed } = yield* importAgent(
					'Check balances.',
					'billing',
					[],
					taken
				)
				expect(parsed.name).toBe('billing-4')
				expect(toAgentName('billing.md', new Set())).toBe('billing')
			})
	)

	test.effect(
		'normalizes a file name that is not an agent name and reports the rename',
		() =>
			Effect.gen(function* () {
				const { parsed, imported } = yield* importAgent(
					'Check balances.',
					'Bad_Name'
				)
				expect(parsed.name).toBe('bad-name')
				expect(
					imported.notes.find(note => note.kind === 'changed')?.detail
				).toContain('written as bad-name.md')
			})
	)

	test.effect(
		'keeps a CRLF body and its import lines with LF line ends, as agent files are read',
		() =>
			Effect.gen(function* () {
				const { imported } = yield* importAgent(
					'---\r\ntitle: Example checks\r\n---\r\nCheck balances.\r\n@/docs/billing.md\r\n'
				)
				expect(
					imported.file.text.endsWith('Check balances.\n@/docs/billing.md\n')
				).toBeTruthy()
			})
	)
})
