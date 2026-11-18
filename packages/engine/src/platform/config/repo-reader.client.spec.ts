import { execFileSync } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
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
import { Effect, Layer } from 'effect'
import { GitService, GitServiceLive, GitWorkdir } from '../git/git.service'
import { makeRefReader, makeWorktreeReader } from './repo-reader.client'

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

layer(NodeLayer, { excludeTestServices: true })('repository readers', test => {
	test.effect(
		'reads current files, sorted direct files, missing paths and ENOTDIR',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write('docs/b.md', 'B')
				repo.write('docs/a.md', 'A')
				repo.write('docs/nested/c.md', 'C')
				const reader = yield* makeWorktreeReader(repo.root)
				expect(reader.source).toBe('working tree')
				expect(yield* reader.readFile('docs/a.md')).toBe('A')
				expect(yield* reader.listFiles('docs')).toEqual(['a.md', 'b.md'])
				expect(yield* reader.readFile('missing')).toBeUndefined()
				expect(yield* reader.listFiles('missing')).toBeUndefined()
				expect(yield* reader.readFile('docs/a.md/child')).toBeUndefined()
			})
	)
	test.effect(
		'lists regular files and file symlinks, enforcing confinement when reading links',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				const outside = createRepo()
				repo.write('docs/z-regular.md', 'Regular file')
				repo.write('shared/target.md', 'Inside data')
				outside.write('target.md', 'Outside data')
				symlinkSync(
					'../shared/target.md',
					join(repo.root, 'docs/a-internal.md')
				)
				symlinkSync(
					join(outside.root, 'target.md'),
					join(repo.root, 'docs/m-external.md')
				)
				symlinkSync('missing.md', join(repo.root, 'docs/broken.md'))
				symlinkSync('../shared', join(repo.root, 'docs/directory'))
				const reader = yield* makeWorktreeReader(repo.root)
				expect(yield* reader.listFiles('docs')).toEqual([
					'a-internal.md',
					'm-external.md',
					'z-regular.md',
				])
				expect(yield* reader.readFile('docs/a-internal.md')).toBe('Inside data')
				expect(
					yield* reader.readFile('docs/m-external.md').pipe(Effect.flip)
				).toMatchObject({
					_tag: 'ConfigError',
					source: 'docs/m-external.md',
					reason: 'resolves outside the repository (symlink)',
				})
			})
	)
	test.effect(
		'requires exact casing in every component, including internal directory symlinks',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write('docs/notes.md', 'Project notes.')
				repo.write('.mng/agents/example.md', 'Example')
				symlinkSync('../docs', join(repo.root, '.mng/link'))
				const reader = yield* makeWorktreeReader(repo.root)
				expect(yield* reader.readFile('.mng/link/notes.md')).toBe(
					'Project notes.'
				)
				for (const path of [
					'.mng/LINK/notes.md',
					'.mng/link/NOTES.md',
					'Docs/notes.md',
				])
					expect(yield* reader.readFile(path)).toBeUndefined()
				expect(yield* reader.listFiles('.mng/AGENTS')).toBeUndefined()
			})
	)
	test.effect('refuses external symlinks but permits internal links', () =>
		Effect.gen(function* () {
			const repo = createRepo()
			const outside = createRepo()
			outside.write('private.md', 'Outside data')
			repo.write('inside.md', 'Inside data')
			symlinkSync(
				join(outside.root, 'private.md'),
				join(repo.root, 'escape.md')
			)
			symlinkSync(outside.root, join(repo.root, 'escape-dir'))
			symlinkSync('inside.md', join(repo.root, 'internal.md'))
			const reader = yield* makeWorktreeReader(repo.root)
			for (const path of ['escape.md', 'escape-dir', 'escape-dir/private.md'])
				for (const failure of [
					yield* reader.readFile(path).pipe(Effect.flip),
					yield* reader.listFiles(path).pipe(Effect.flip),
				])
					expect(failure).toMatchObject({
						_tag: 'ConfigError',
						source: path,
						reason: 'resolves outside the repository (symlink)',
					})
			expect(yield* reader.readFile('internal.md')).toBe('Inside data')
		})
	)
	test.effect(
		'ref reader uses the named commit despite edits, deletion and untracked files',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write('.mng/agents/auth.md', 'committed')
				repo.write('.mng/agents/billing.md', 'billing')
				repo.write('.mng/agents/nested/hidden.md', 'hidden')
				const commit = repo.commit()
				repo.write('.mng/agents/auth.md', 'working')
				rmSync(join(repo.root, '.mng/agents/billing.md'))
				repo.write('.mng/agents/new.md', 'untracked')
				yield* Effect.gen(function* () {
					const reader = makeRefReader(yield* GitService, 'main', commit)
					expect(reader.source).toBe('main')
					expect(yield* reader.readFile('.mng/agents/auth.md')).toBe(
						'committed'
					)
					expect(yield* reader.listFiles('.mng/agents')).toEqual([
						'auth.md',
						'billing.md',
					])
					expect(yield* reader.readFile('missing')).toBeUndefined()
					expect(yield* reader.listFiles('missing')).toBeUndefined()
					for (const path of ['/outside', '../escape', 'C:/bad', 'a\\b'])
						expect(
							yield* reader.readFile(path).pipe(Effect.flip)
						).toMatchObject({ _tag: 'ConfigError' })
				}).pipe(Effect.provide(gitLayer(repo.root)))
			})
	)
})
