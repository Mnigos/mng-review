import { execFileSync } from 'node:child_process'
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	NodeChildProcessSpawner,
	NodeFileSystem,
	NodePath,
} from '@effect/platform-node-shared'
import { layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, PlatformError } from 'effect'
import { GitServiceLive, GitWorkdir } from '../git/git.service'
import { RulesService, RulesServiceLive } from './rules.service'

const roots: string[] = []
const NodeLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const ProcessLayer = NodeChildProcessSpawner.layer.pipe(
	Layer.provide(NodeLayer)
)

/** Creates an isolated repository; all fixture commands disable hooks and signing. */
function createRepo(name = 'repo') {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), 'mng-review-spec-')))
	roots.push(parent)
	const root = join(parent, name)
	mkdirSync(root)
	const git = (...args: string[]) =>
		execFileSync(
			'git',
			[
				'-c',
				'user.name=Author',
				'-c',
				'user.email=author@example.test',
				'-c',
				'commit.gpgsign=false',
				'-c',
				'core.hooksPath=/dev/null',
				...args,
			],
			{
				cwd: root,
				encoding: 'utf-8',
				env: {
					...process.env,
					GIT_CONFIG_GLOBAL: '/dev/null',
					GIT_CONFIG_NOSYSTEM: '1',
					GIT_TERMINAL_PROMPT: '0',
				},
			}
		).trimEnd()
	const write = (path: string, text: string | Uint8Array) => {
		const full = join(root, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, text)
	}
	const commit = () => {
		git('add', '--all')
		git('commit', '-m', 'fixture')
		return git('rev-parse', 'HEAD')
	}
	git('init', '--initial-branch=main')
	return { root, git, write, commit }
}

afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true })
})

/** Builds the service against this spec's repository, without changing the process directory. */
function gitLayer(root: string) {
	return GitServiceLive.pipe(
		Layer.provide(ProcessLayer),
		Layer.provide(Layer.succeed(GitWorkdir, { cwd: root }))
	)
}

/** Combines real git and file services with the rules loader. */
function rulesLayer(root: string) {
	return RulesServiceLive.pipe(
		Layer.provide(gitLayer(root)),
		Layer.provide(NodeLayer)
	)
}

layer(NodeLayer, { excludeTestServices: true })('RulesService', test => {
	test.effect(
		'absent rules use defaults and agents load in name order with imports expanded',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write('.mng/agents/z.md', '---\nkind: bug\n---\nCheck Z.')
				repo.write(
					'.mng/agents/auth.md',
					'---\nkind: bug\n---\n@/docs/auth.md#Rules'
				)
				repo.write('.mng/agents/nested/hidden.md', 'not an agent')
				repo.write('.mng/agents/ignore.txt', 'ignored')
				repo.write(
					'docs/auth.md',
					'# Guide\n## Rules\nCheck ownership.\n## Other\nSkip this.'
				)
				const rules = yield* RulesService.use(service =>
					service.load(undefined)
				).pipe(Effect.provide(rulesLayer(repo.root)))
				expect(rules.source).toBe('working tree')
				expect(
					rules.agents.map(agent => [agent.name, agent.instructions])
				).toEqual([
					['auth', '## Rules\nCheck ownership.'],
					['z', 'Check Z.'],
				])
				expect(rules.config.models.router.model).toBeTruthy()
				rmSync(join(repo.root, '.mng'), { recursive: true, force: true })
				expect(
					(yield* RulesService.use(service => service.load(undefined)).pipe(
						Effect.provide(rulesLayer(repo.root))
					)).agents
				).toEqual([])
			})
	)
	test.effect(
		'expands whole-file imports once and preserves directives inside imported text',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write(
					'.mng/agents/auth.md',
					'---\nkind: bug\n---\nBefore.\n@/docs/rules.md\nAfter.'
				)
				repo.write('docs/rules.md', 'Check behavior.\n@/missing.md\n\n')
				const rules = yield* RulesService.use(service =>
					service.load(undefined)
				).pipe(Effect.provide(rulesLayer(repo.root)))
				expect(rules.agents[0]?.instructions).toBe(
					'Before.\nCheck behavior.\n@/missing.md\nAfter.'
				)
			})
	)

	test.effect('unknown config key names its dotted location', () =>
		Effect.gen(function* () {
			const repo = createRepo()
			repo.write('.mng/review.yml', 'comments: {max_nit: 2}')
			const failure = yield* RulesService.use(service =>
				service.load(undefined)
			).pipe(Effect.provide(rulesLayer(repo.root)), Effect.flip)
			expect(failure).toMatchObject({ _tag: 'ConfigError' })
			expect(failure.message).toContain('comments.max_nit')
		})
	)
	for (const line of ['@/missing.md', '@/docs/auth.md#Missing'])
		test.effect(
			`missing import or heading names the agent and exact import line ${line}`,
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					repo.write('.mng/agents/auth.md', `---\nkind: bug\n---\n${line}`)
					repo.write('docs/auth.md', '# Present\nText')
					const failure = yield* RulesService.use(service =>
						service.load(undefined)
					).pipe(Effect.provide(rulesLayer(repo.root)), Effect.flip)
					expect(failure).toMatchObject({
						_tag: 'ConfigError',
						source: '.mng/agents/auth.md',
					})
					expect(failure.message).toContain(line)
				})
		)
	test.effect(
		'rules-ref reads config, agents and imports from the commit despite invalid replacements',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write('.mng/review.yml', 'comments: {max_nits: 3}')
				repo.write(
					'.mng/agents/auth.md',
					'---\nkind: bug\n---\n@/docs/auth.md#Rules'
				)
				repo.write('docs/auth.md', '# Guide\n## Rules\nCommitted instructions.')
				const commit = repo.commit()
				repo.write('.mng/review.yml', 'unknown: true')
				repo.write(
					'.mng/agents/auth.md',
					'---\nkind: invalid\n---\n@/missing.md'
				)
				repo.write('.mng/agents/untracked.md', 'not front matter')
				rmSync(join(repo.root, 'docs/auth.md'))
				yield* Effect.gen(function* () {
					const service = yield* RulesService
					const rules = yield* service.load(commit)
					expect(rules.source).toBe(commit)
					expect(rules.config.comments.max_nits).toBe(3)
					expect(
						rules.agents.map(agent => [agent.name, agent.instructions])
					).toEqual([['auth', '## Rules\nCommitted instructions.']])
					expect(
						yield* service.load(undefined).pipe(Effect.flip)
					).toMatchObject({ _tag: 'ConfigError' })
				}).pipe(Effect.provide(rulesLayer(repo.root)))
			})
	)
	test.effect(
		'a listed agent that disappears during read is an error naming its file',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write(
					'.mng/agents/auth.md',
					'---\nkind: bug\n---\nCheck ownership.'
				)
				const fs = yield* FileSystem.FileSystem
				const readFileStringSpy = vi
					.fn(fs.readFileString)
					.mockImplementation((path, encoding) =>
						path.endsWith('/auth.md')
							? Effect.fail(
									PlatformError.systemError({
										_tag: 'NotFound',
										module: 'FileSystem',
										method: 'readFileString',
										pathOrDescriptor: path,
									})
								)
							: fs.readFileString(path, encoding)
					)
				const failure = yield* RulesService.use(service =>
					service.load(undefined)
				).pipe(
					Effect.provide(
						RulesServiceLive.pipe(Layer.provide(gitLayer(repo.root)))
					),
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						readFileString: readFileStringSpy,
					}),
					Effect.flip
				)
				expect(readFileStringSpy).toHaveBeenCalled()
				expect(failure).toMatchObject({
					_tag: 'ConfigError',
					source: '.mng/agents/auth.md',
				})
				expect(failure.message).toContain('cannot be read')
			})
	)
	test.effect('an unreadable review.yml is an error rather than defaults', () =>
		Effect.gen(function* () {
			const repo = createRepo()
			repo.write('.mng/review.yml', 'depth: deep')
			chmodSync(join(repo.root, '.mng/review.yml'), 0)
			const failure = yield* RulesService.use(service =>
				service.load(undefined)
			).pipe(Effect.provide(rulesLayer(repo.root)), Effect.flip)
			expect(failure).toMatchObject({
				_tag: 'ConfigError',
				source: '.mng/review.yml',
			})
			expect(failure.message).toContain('cannot be read')
		})
	)
	test.effect(
		'permission failures name the path rather than being treated as absence',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write(
					'.mng/agents/auth.md',
					'---\nkind: bug\n---\nCheck ownership.'
				)
				chmodSync(join(repo.root, '.mng/agents/auth.md'), 0)
				const failure = yield* RulesService.use(service =>
					service.load(undefined)
				).pipe(Effect.provide(rulesLayer(repo.root)), Effect.flip)
				expect(failure).toMatchObject({
					_tag: 'ConfigError',
					source: '.mng/agents/auth.md',
				})
			})
	)
})
