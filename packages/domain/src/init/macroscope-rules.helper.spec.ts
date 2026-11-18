import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { Yaml } from 'effect/encoding'
import { parseAgentFile } from '../agents/agent-file.parser'
import { AGENTS_DIR } from '../agents/agent.constants'
import {
	CONFIG_PATH,
	CONTEXT_PATH,
	DEFAULT_PRESET_NAME,
	MEMORY_PATH,
} from '../config/review-config.constants'
import { parseReviewConfig } from '../config/review-config.parser'
import {
	MACROSCOPE_APPROVABILITY_PATH,
	MACROSCOPE_CORRECTNESS_PATH,
} from './init.constants'
import { isDocGlob, toMacroscopeRules } from './macroscope-rules.helper'
import { CONTEXT_HEADINGS, STARTER_FILES } from './starter-rules.constants'

for (const glob of [
	'docs/**',
	'**/docs/**',
	'doc/*',
	'documentation/**',
	'**/*.md',
	'*.mdx',
	'**/*.markdown',
	'**/*.rst',
	'**/*.adoc',
	'**/*.txt',
	'README',
	'README.md',
	'CHANGELOG.md',
	'LICENSE',
	'CONTRIBUTING.md',
])
	test(`recognizes documentation glob ${glob}`, () => {
		expect(isDocGlob(glob)).toBe(true)
	})

for (const glob of [
	'src/**',
	'src/billing/*.ts',
	'**/*.ts',
	'docs-helper/**',
	'src/documentation.ts',
	'**/readme-helper.ts',
	'**/README.ts',
	'!**/*.md',
	'!docs/**',
	'*',
	'',
])
	test(`does not treat source glob ${glob} as documentation`, () => {
		expect(isDocGlob(glob)).toBe(false)
	})

layer(Layer.empty)('Macroscope rules', test => {
	test.effect(
		'builds decodable review rules, context, empty memory and agents from all sources',
		() =>
			Effect.gen(function* () {
				const draft = yield* toMacroscopeRules({
					correctness: {
						path: MACROSCOPE_CORRECTNESS_PATH,
						text: '---\nexclude: [generated/**, docs/**]\nrequires: [ci]\ncustomCorrectness: true\n---\nExample context.\n',
					},
					approvability: {
						path: MACROSCOPE_APPROVABILITY_PATH,
						text: "---\nneverApprove: ['src/billing/**', 'src/billing/**']\nalwaysApprove: ['docs/**', '**/*.md', 'src/**']\ncustomApproval: true\n---\nApproval criteria.\n",
					},
					agents: [
						{
							path: '.macroscope/check-run-agents/billing.md',
							text: '---\ntitle: Example checks\nrequires: [unit]\n---\nCheck balances.',
						},
					],
				})
				const configText = draft.files.find(
					file => file.path === CONFIG_PATH
				)?.text
				expect(configText).toBeDefined()
				expect(Yaml.parse(configText ?? '')).toEqual({
					extends: DEFAULT_PRESET_NAME,
					risk_paths: ['src/billing/**'],
					skip: { paths: ['generated/**', 'docs/**', '**/*.md'] },
				})
				const config = yield* parseReviewConfig(configText)
				expect(config.risk_paths).toEqual(['src/billing/**'])
				expect(config.skip.paths).toEqual([
					'generated/**',
					'docs/**',
					'**/*.md',
				])
				expect(config.skip.paths).not.toContain('src/**')
				expect(draft.files.find(file => file.path === CONTEXT_PATH)?.text).toBe(
					'Example context.\n'
				)
				expect(draft.files.find(file => file.path === MEMORY_PATH)?.text).toBe(
					''
				)
				const agent = draft.files.find(
					file => file.path === `${AGENTS_DIR}/billing.md`
				)
				expect(agent).toBeDefined()
				expect(
					(yield* parseAgentFile('billing', agent?.text ?? '')).frontMatter
						.needs
				).toEqual(['unit', 'ci'])
				for (const detail of [
					'src/**',
					'the body',
					'customCorrectness',
					'customApproval',
				])
					expect(
						draft.notes.some(
							note => note.kind === 'dropped' && note.detail.includes(detail)
						)
					).toBeTruthy()
				expect(draft.files.map(file => file.text).join('\n')).not.toContain(
					'Approval criteria.'
				)
			})
	)

	for (const body of [undefined, '', ' \n\t\n'])
		test.effect(
			`uses the starter context when correctness is ${JSON.stringify(body)}`,
			() =>
				Effect.gen(function* () {
					const draft = yield* toMacroscopeRules({
						agents: [],
						...(body === undefined
							? {}
							: {
									correctness: {
										path: MACROSCOPE_CORRECTNESS_PATH,
										text: body,
									},
								}),
					})
					expect(
						draft.files.find(file => file.path === CONTEXT_PATH)?.text
					).toBe(STARTER_FILES.find(file => file.path === CONTEXT_PATH)?.text)
					expect(
						draft.notes.find(
							note =>
								note.kind === 'guessed' &&
								note.source === MACROSCOPE_CORRECTNESS_PATH
						)?.detail
					).toContain('starter template')
					expect(draft.agents).toEqual([])
				})
		)

	test.effect(
		'allocates collision-free names across imported agents and decodes each',
		() =>
			Effect.gen(function* () {
				const draft = yield* toMacroscopeRules({
					agents: ['reviewer', 'reviewer-agent', 'billing'].map(name => ({
						path: `.macroscope/check-run-agents/${name}.md`,
						text: 'Check balances.',
					})),
				})
				expect(new Set(draft.agents.map(agent => agent.name)).size).toBe(3)
				for (const file of draft.files.filter(candidate =>
					candidate.path.startsWith(`${AGENTS_DIR}/`)
				)) {
					const name = file.path.slice(AGENTS_DIR.length + 1, -3)
					expect((yield* parseAgentFile(name, file.text, file.path)).name).toBe(
						name
					)
				}
			})
	)

	test.effect(
		'starter extends the default preset and provides context, memory and one agent of each kind',
		() =>
			Effect.gen(function* () {
				const configText = STARTER_FILES.find(
					file => file.path === CONFIG_PATH
				)?.text
				expect(configText).toBeDefined()
				expect(Yaml.parse(configText ?? '')).toMatchObject({
					extends: DEFAULT_PRESET_NAME,
				})
				expect(yield* parseReviewConfig(configText)).toMatchObject({
					risk_paths: [],
					skip: { paths: [] },
				})
				const context = STARTER_FILES.find(
					file => file.path === CONTEXT_PATH
				)?.text
				for (const heading of CONTEXT_HEADINGS)
					expect(context).toContain(heading)
				expect(
					STARTER_FILES.find(file => file.path === MEMORY_PATH)?.text
				).toBe('')
				const agents = yield* Effect.forEach(
					STARTER_FILES.filter(file => file.path.startsWith(`${AGENTS_DIR}/`)),
					file =>
						parseAgentFile(
							file.path.slice(AGENTS_DIR.length + 1, -3),
							file.text,
							file.path
						)
				)
				expect(agents.map(agent => agent.frontMatter.kind).toSorted()).toEqual([
					'bug',
					'nit',
				])
			})
	)
})
