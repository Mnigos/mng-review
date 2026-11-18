import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { ConfigError } from '../config/config.errors'
import { parseMacroscopeFile } from './macroscope-file.parser'
import {
	macroscopeAgentSchema,
	macroscopeApprovabilitySchema,
	macroscopeCorrectnessSchema,
} from './macroscope-file.schema'

const SOURCE = '.macroscope/check-run-agents/billing.md'

layer(Layer.empty)('parseMacroscopeFile', test => {
	test.effect(
		'decodes every known agent key and lists unknown keys in file order',
		() =>
			Effect.gen(function* () {
				expect(
					yield* parseMacroscopeFile(macroscopeAgentSchema, {
						path: SOURCE,
						text: `---
lastUnknown: true
title: Example checks
include: ['src/billing/**']
exclude: ['**/*.spec.ts']
labels: [billing]
authors: [author-a]
targets: [main]
requires: [ci]
input: full_diff
firstUnknown: 3
---
 Check. \n@/docs/billing.md\n`,
					})
				).toEqual({
					fields: {
						title: 'Example checks',
						include: ['src/billing/**'],
						exclude: ['**/*.spec.ts'],
						labels: ['billing'],
						authors: ['author-a'],
						targets: ['main'],
						requires: ['ci'],
						input: 'full_diff',
					},
					otherKeys: ['lastUnknown', 'firstUnknown'],
					body: ' Check. \n@/docs/billing.md\n',
				})
			})
	)

	test.effect('decodes correctness and approvability list keys', () =>
		Effect.gen(function* () {
			expect(
				(yield* parseMacroscopeFile(macroscopeCorrectnessSchema, {
					path: 'correctness.md',
					text: '---\nexclude: [generated/**]\nrequires: [ci]\n---\nContext',
				})).fields
			).toEqual({ exclude: ['generated/**'], requires: ['ci'] })
			expect(
				(yield* parseMacroscopeFile(macroscopeApprovabilitySchema, {
					path: 'approvability.md',
					text: '---\nneverApprove: [src/billing/**]\nalwaysApprove: [docs/**]\n---\nCriteria',
				})).fields
			).toEqual({
				neverApprove: ['src/billing/**'],
				alwaysApprove: ['docs/**'],
			})
		})
	)

	for (const body of [
		'No front matter\n@/docs/billing.md\n',
		'\n---\ntitle: still body\n---\n',
		'',
	])
		test.effect(
			`keeps a file without opening front matter as body ${JSON.stringify(body)}`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* parseMacroscopeFile(macroscopeAgentSchema, {
							path: SOURCE,
							text: body,
						})
					).toEqual({ fields: {}, otherKeys: [], body })
				})
		)

	test.effect('accepts BOM and CRLF delimiters', () =>
		Effect.gen(function* () {
			expect(
				yield* parseMacroscopeFile(macroscopeAgentSchema, {
					path: SOURCE,
					text: '\uFEFF---\r\ntitle: Example checks\r\n---\r\nBody\r\n',
				})
			).toEqual({
				fields: { title: 'Example checks' },
				otherKeys: [],
				body: 'Body\n',
			})
		})
	)

	for (const yaml of [
		'include: [',
		'include: src/**',
		'requires: true',
		'- item',
		'title: Example\nmissing delimiter',
	])
		test.effect(
			`rejects malformed front matter ${JSON.stringify(yaml)} with its file`,
			() =>
				Effect.gen(function* () {
					const error = yield* Effect.flip(
						parseMacroscopeFile(macroscopeAgentSchema, {
							path: SOURCE,
							text: `---\n${yaml}${yaml.includes('missing delimiter') ? '' : '\n---\nBody'}`,
						})
					)
					expect(error).toBeInstanceOf(ConfigError)
					expect(error.source).toBe(SOURCE)
					expect(error.message).toContain(SOURCE)
				})
		)
})
