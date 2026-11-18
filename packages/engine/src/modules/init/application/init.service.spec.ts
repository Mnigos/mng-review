import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { layer } from '@effect/vitest'
import {
	CONFIG_PATH,
	ConfigError,
	CONTEXT_PATH,
	MACROSCOPE_APPROVABILITY_PATH,
	MACROSCOPE_CORRECTNESS_PATH,
	MEMORY_PATH,
	STARTER_FILES,
} from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import {
	RulesService,
	RulesServiceLive,
} from '../../../platform/config/rules.service'
import {
	cleanupRepos,
	createRepo,
	FileSystemLayer,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { InitError } from '../domain/init.errors'
import { InitService, InitServiceLive, type InitOptions } from './init.service'

const STARTER_OPTIONS = {
	fromMacroscope: false,
	force: false,
} as const satisfies InitOptions
const IMPORT_OPTIONS = {
	fromMacroscope: true,
	force: false,
} as const satisfies InitOptions

/** Uses real git root discovery and the Node file system for initialization. */
function initLayer(cwd: string) {
	return InitServiceLive.pipe(
		Layer.provide(gitLayer(cwd)),
		Layer.provide(FileSystemLayer)
	)
}

/** Reads rules written by init through the production rules loader. */
function rulesLayer(root: string) {
	return RulesServiceLive.pipe(
		Layer.provide(gitLayer(root)),
		Layer.provide(FileSystemLayer)
	)
}

afterEach(() => {
	cleanupRepos()
})

layer(Layer.empty, { excludeTestServices: true })('InitService', test => {
	for (const fromSubdirectory of [false, true])
		test.effect(
			`writes all starter files at the git root from ${fromSubdirectory ? 'a subdirectory' : 'the root'}`,
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					const cwd = fromSubdirectory
						? join(repo.root, 'src/billing')
						: repo.root
					mkdirSync(cwd, { recursive: true })
					const report = yield* InitService.use(service =>
						service.init(STARTER_OPTIONS)
					).pipe(Effect.provide(initLayer(cwd)))
					expect(report.root).toBe(repo.root)
					expect(report.source).toBe('starter')
					expect(report.files).toEqual(
						STARTER_FILES.map(file => ({ path: file.path, status: 'created' }))
					)
					for (const file of STARTER_FILES)
						expect(readFileSync(join(repo.root, file.path), 'utf-8')).toBe(
							file.text
						)
					if (fromSubdirectory)
						expect(existsSync(join(cwd, '.mng'))).toBe(false)
					expect(report.notes).toEqual([])
				})
		)

	for (const empty of [false, true])
		test.effect(
			`refuses an existing ${empty ? 'empty' : 'populated'} .mng directory without writing`,
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					mkdirSync(join(repo.root, '.mng'))
					if (!empty) repo.write(CONFIG_PATH, 'Existing settings.\n')
					const error = yield* InitService.use(service =>
						service.init(STARTER_OPTIONS)
					).pipe(Effect.provide(initLayer(repo.root)), Effect.flip)
					expect(error).toBeInstanceOf(InitError)
					expect(error.message).toContain('.mng/ already exists')
					expect(error.message).toContain('--force')
					expect(readdirSync(join(repo.root, '.mng'))).toEqual(
						empty ? [] : ['review.yml']
					)
					if (!empty)
						expect(readFileSync(join(repo.root, CONFIG_PATH), 'utf-8')).toBe(
							'Existing settings.\n'
						)
				})
		)

	test.effect(
		'force overwrites generated files, reports statuses and leaves other files alone',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				for (const file of STARTER_FILES) repo.write(file.path, 'Old contents.')
				repo.write('.mng/local.txt', 'Keep local notes.\n')
				repo.write(
					'.mng/agents/custom.md',
					'---\nkind: bug\n---\nCustom instructions.'
				)
				const report = yield* InitService.use(service =>
					service.init({ ...STARTER_OPTIONS, force: true })
				).pipe(Effect.provide(initLayer(repo.root)))
				expect(report.files).toEqual(
					STARTER_FILES.map(file => ({
						path: file.path,
						status: 'overwritten',
					}))
				)
				for (const file of STARTER_FILES)
					expect(readFileSync(join(repo.root, file.path), 'utf-8')).toBe(
						file.text
					)
				expect(readFileSync(join(repo.root, '.mng/local.txt'), 'utf-8')).toBe(
					'Keep local notes.\n'
				)
				expect(
					readFileSync(join(repo.root, '.mng/agents/custom.md'), 'utf-8')
				).toBe('---\nkind: bug\n---\nCustom instructions.')
			})
	)

	test.effect(
		'imports a full fixture, preserves all source bytes and loads the written rules',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				const sources = [
					{
						path: MACROSCOPE_CORRECTNESS_PATH,
						text: '---\r\nexclude: [generated/**]\r\nrequires: [ci]\r\n---\r\nExample context.\r\n',
					},
					{
						path: MACROSCOPE_APPROVABILITY_PATH,
						text: '---\nneverApprove: [src/billing/**]\nalwaysApprove: [docs/**, src/**]\n---\nApproval criteria.\n',
					},
					{
						path: '.macroscope/check-run-agents/billing.md',
						text: '---\ntitle: Example checks\ninput: code_object\nrequires: [ci, unit]\n---\n@/docs/billing.md\n',
					},
					{
						path: '.macroscope/check-run-agents/conventions.md',
						text: '---\ntitle: Example conventions\n---\nCheck naming.\n',
					},
					{
						path: '.macroscope/other.txt',
						text: '\uFEFFLeave this alone.\r\n',
					},
				] as const
				for (const source of sources) repo.write(source.path, source.text)
				repo.write('docs/billing.md', 'Check balance updates.\n')
				const report = yield* InitService.use(service =>
					service.init(IMPORT_OPTIONS)
				).pipe(Effect.provide(initLayer(repo.root)))
				expect(report.source).toBe('macroscope')
				expect(report.files.map(file => file.path)).toEqual([
					CONFIG_PATH,
					CONTEXT_PATH,
					MEMORY_PATH,
					'.mng/agents/billing.md',
					'.mng/agents/conventions.md',
				])
				expect(
					report.files.every(file => file.status === 'created')
				).toBeTruthy()
				expect(report.agents.map(agent => [agent.name, agent.kind])).toEqual([
					['billing', 'bug'],
					['conventions', 'nit'],
				])
				for (const source of sources)
					expect(readFileSync(join(repo.root, source.path))).toEqual(
						Buffer.from(source.text)
					)
				const rules = yield* RulesService.use(service =>
					service.load(undefined)
				).pipe(Effect.provide(rulesLayer(repo.root)))
				expect(rules.config.risk_paths).toEqual(['src/billing/**'])
				expect(rules.config.skip.paths).toEqual(['generated/**', 'docs/**'])
				expect(rules.context).toBe('Example context.\n')
				expect(rules.memory).toBe('')
				expect(rules.agents[0]).toMatchObject({
					name: 'billing',
					frontMatter: { input: 'full_diff', needs: ['ci', 'unit'] },
					instructions: 'Check balance updates.',
				})
			})
	)

	for (const directory of ['missing', 'empty', 'unrelated files'] as const)
		test.effect(
			`rejects ${directory} .macroscope with InitError and writes nothing`,
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					if (directory !== 'missing') mkdirSync(join(repo.root, '.macroscope'))
					if (directory === 'unrelated files')
						repo.write('.macroscope/notes.md', 'Not an import source.')
					const error = yield* InitService.use(service =>
						service.init(IMPORT_OPTIONS)
					).pipe(Effect.provide(initLayer(repo.root)), Effect.flip)
					expect(error).toBeInstanceOf(InitError)
					expect(error.message).toContain(
						directory === 'missing' ? 'no .macroscope/' : 'nothing to import'
					)
					expect(existsSync(join(repo.root, '.mng'))).toBe(false)
				})
		)

	for (const malformed of [
		{
			path: MACROSCOPE_CORRECTNESS_PATH,
			text: '---\nexclude: [\n---\nContext',
		},
		{
			path: '.macroscope/check-run-agents/z-broken.md',
			text: '---\ninclude: src/**\n---\nCheck.',
		},
	] as const)
		test.effect(
			`validates ${malformed.path} before writing any draft file`,
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					repo.write(
						'.macroscope/check-run-agents/a-valid.md',
						'Check balances.'
					)
					repo.write(malformed.path, malformed.text)
					const error = yield* InitService.use(service =>
						service.init(IMPORT_OPTIONS)
					).pipe(Effect.provide(initLayer(repo.root)), Effect.flip)
					expect(error).toBeInstanceOf(ConfigError)
					expect(error.message).toContain(malformed.path)
					expect(existsSync(join(repo.root, '.mng'))).toBe(false)
				})
		)

	test.effect('loads the starter with RulesServiceLive', () =>
		Effect.gen(function* () {
			const repo = createRepo()
			yield* InitService.use(service => service.init(STARTER_OPTIONS)).pipe(
				Effect.provide(initLayer(repo.root))
			)
			const rules = yield* RulesService.use(service =>
				service.load(undefined)
			).pipe(Effect.provide(rulesLayer(repo.root)))
			expect(rules.source).toBe('working tree')
			expect(
				rules.agents.map(agent => agent.frontMatter.kind).toSorted()
			).toEqual(['bug', 'nit'])
			expect(rules.context).toBe(
				STARTER_FILES.find(file => file.path === CONTEXT_PATH)?.text
			)
			expect(rules.memory).toBe('')
		})
	)
})
