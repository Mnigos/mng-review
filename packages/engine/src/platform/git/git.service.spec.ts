import { execFileSync } from 'node:child_process'
import {
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
import * as Domain from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import { GitService, GitServiceLive, GitWorkdir } from './git.service'

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

layer(Layer.empty, { excludeTestServices: true })('GitService', test => {
	test.effect(
		'reads merge-base counts and committed blob sizes after the base advances',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write('src/modify.ts', 'old\nkeep\n')
				repo.write('src/delete.ts', 'gone\n')
				repo.write('src/rename.ts', 'unique renamed content\n')
				const mergeBase = repo.commit()
				repo.git('checkout', '-b', 'feature')
				repo.write('src/add.ts', 'added\nsecond\n')
				repo.write('src/modify.ts', 'new\nkeep\nextra\n')
				rmSync(join(repo.root, 'src/delete.ts'))
				repo.git('mv', 'src/rename.ts', 'src/renamed.ts')
				repo.write('assets/image.bin', new Uint8Array([0, 1, 2, 3, 0, 255]))
				repo.write('src/line\nbreak.ts', 'hello\n')
				repo.write('src/with\ttab.ts', 'tab\n')
				const head = repo.commit()
				repo.git('checkout', 'main')
				repo.write('base-only.ts', 'not part of change\n')
				const base = repo.commit()
				repo.git('checkout', 'feature')
				repo.write('src/add.ts', 'uncommitted and much longer')
				const change = yield* GitService.use(git =>
					git.readChange('main', 'HEAD')
				).pipe(Effect.provide(gitLayer(repo.root)))
				expect(change).toMatchObject({
					base: { ref: 'main', commit: base },
					head: { ref: 'HEAD', commit: head },
					mergeBase,
				})
				expect(change.files).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							path: 'assets/image.bin',
							status: 'added',
							binary: true,
							sizeBytes: 6,
							additions: 0,
							deletions: 0,
						}),
						expect.objectContaining({
							path: 'src/add.ts',
							status: 'added',
							sizeBytes: 13,
							additions: 2,
							deletions: 0,
						}),
						expect.objectContaining({
							path: 'src/delete.ts',
							status: 'deleted',
							sizeBytes: 0,
							additions: 0,
							deletions: 1,
						}),
						expect.objectContaining({
							path: 'src/modify.ts',
							sizeBytes: 15,
							additions: 2,
							deletions: 1,
						}),
						expect.objectContaining({
							path: 'src/renamed.ts',
							status: 'renamed',
							oldPath: 'src/rename.ts',
							sizeBytes: 23,
							additions: 0,
							deletions: 0,
						}),
						expect.objectContaining({
							path: 'src/line\nbreak.ts',
							sizeBytes: 6,
							additions: 1,
						}),
						expect.objectContaining({
							path: 'src/with\ttab.ts',
							sizeBytes: 4,
							additions: 1,
						}),
					])
				)
				expect(change.files).toHaveLength(7)
			})
	)
	test.effect(
		'rename diff includes both old and new paths and disables external diff and textconv',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write('old.ts', 'unique content\n'.repeat(20))
				repo.commit()
				repo.git('checkout', '-b', 'feature')
				repo.git('mv', 'old.ts', 'new.ts')
				repo.commit()
				repo.git('config', 'diff.external', 'this-command-must-never-run')
				repo.git(
					'config',
					'diff.fixture.textconv',
					'this-command-must-never-run'
				)
				repo.write('.gitattributes', '*.ts diff=fixture\n')
				yield* Effect.gen(function* () {
					const git = yield* GitService
					const change = yield* git.readChange('main', 'HEAD')
					expect(change.files[0]?.status).toBe('renamed')
					const diff = yield* git.readDiff(change, change.files)
					expect(diff).toContain('rename from old.ts')
					expect(diff).toContain('rename to new.ts')
					expect(diff).not.toContain('deleted file mode')
					expect(yield* git.readDiff(change, [])).toBe('')
				}).pipe(Effect.provide(gitLayer(repo.root)))
			})
	)
	test.effect(
		'readDiff preserves path prefixes when diff.noprefix is enabled',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write('src/example.ts', 'before\n')
				const base = repo.commit()
				repo.write('src/example.ts', 'after\n')
				repo.commit()
				repo.git('config', 'diff.noprefix', 'true')
				expect(repo.git('diff', base, 'HEAD')).toContain('+++ src/example.ts')
				yield* Effect.gen(function* () {
					const git = yield* GitService
					const change = yield* git.readChange(base, 'HEAD')
					const diff = yield* git.readDiff(change, change.files)
					expect(diff).toContain('--- a/src/example.ts')
					expect(diff).toContain('+++ b/src/example.ts')
				}).pipe(Effect.provide(gitLayer(repo.root)))
			})
	)
	test.effect('readDiff keeps gitlink blocks when diff.submodule is log', () =>
		Effect.gen(function* () {
			const repo = createRepo()
			repo.write('example.ts', 'before\n')
			const first = repo.commit()
			repo.write('example.ts', 'after\n')
			const second = repo.commit()
			repo.git('update-index', '--add', '--cacheinfo', `160000,${first},module`)
			repo.git('commit', '-m', 'fixture gitlink base')
			const base = repo.git('rev-parse', 'HEAD')
			repo.git('update-index', '--cacheinfo', `160000,${second},module`)
			repo.git('commit', '-m', 'fixture gitlink head')
			repo.git('config', 'diff.submodule', 'log')
			expect(repo.git('diff', base, 'HEAD')).toContain('Submodule module')
			expect(repo.git('diff', base, 'HEAD')).not.toContain('diff --git')
			yield* Effect.gen(function* () {
				const git = yield* GitService
				const change = yield* git.readChange(base, 'HEAD')
				const diff = yield* git.readDiff(change, change.files)
				expect(diff).toContain('diff --git a/module b/module')
				expect(diff).toContain(`-Subproject commit ${first}`)
				expect(diff).toContain(`+Subproject commit ${second}`)
				expect(Domain.parseFileDiffs(diff).map(file => file.path)).toEqual([
					'module',
				])
			}).pipe(Effect.provide(gitLayer(repo.root)))
		})
	)
	test.effect('keeps leading and trailing spaces in the repository root', () =>
		Effect.gen(function* () {
			const repo = createRepo(' repo with space ')
			repo.write('a', 'x')
			const commit = repo.commit()
			yield* Effect.gen(function* () {
				const git = yield* GitService
				expect(git.root).toBe(repo.root)
				expect(yield* git.resolveCommit('HEAD')).toBe(commit)
			}).pipe(Effect.provide(gitLayer(repo.root)))
		})
	)
	test.effect(
		'resolves refs safely and derives local and remote branch names',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write('a', 'x')
				const commit = repo.commit()
				repo.git('update-ref', 'refs/remotes/origin/main', commit)
				repo.git('tag', 'v1')
				yield* Effect.gen(function* () {
					const git = yield* GitService
					for (const ref of ['-bad', '--help', '', 'missing'])
						expect(
							yield* git.resolveCommit(ref).pipe(Effect.flip)
						).toMatchObject({ _tag: 'ConfigError' })
					expect(yield* git.resolveCommit('main')).toBe(commit)
					expect(yield* git.branchName('origin/main')).toBe('main')
					expect(yield* git.branchName('refs/heads/main')).toBe('main')
					expect(yield* git.branchName(commit)).toBeUndefined()
					expect(yield* git.branchName('v1')).toBeUndefined()
				}).pipe(Effect.provide(gitLayer(repo.root)))
			})
	)
	test.effect(
		'reads only blobs, lists sorted direct blobs and preserves tabs in names',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				repo.write('docs/b.md', 'B')
				repo.write('docs/a\ttab.md', 'A')
				repo.write('docs/nested/c.md', 'C')
				const commit = repo.commit()
				repo.git(
					'update-index',
					'--add',
					'--cacheinfo',
					`160000,${commit},module`
				)
				repo.git('commit', '-m', 'gitlink')
				repo.write('docs/b.md', 'working tree')
				yield* Effect.gen(function* () {
					const git = yield* GitService
					expect(yield* git.readFileAt('HEAD', 'docs/b.md')).toBe('B')
					for (const path of ['docs', 'module', 'missing'])
						expect(yield* git.readFileAt('HEAD', path)).toBeUndefined()
					expect(yield* git.listFilesAt('HEAD', 'docs')).toEqual([
						'a\ttab.md',
						'b.md',
					])
					expect(yield* git.listFilesAt('HEAD', 'missing')).toBeUndefined()
					const failure = yield* git
						.readFileAt('bogus-commit', 'docs/b.md')
						.pipe(Effect.flip)
					expect(failure).toMatchObject({ _tag: 'GitError' })
					expect(failure.stderr).toContain('bogus-commit')
					expect(failure.exitCode).not.toBe(0)
				}).pipe(Effect.provide(gitLayer(repo.root)))
			})
	)
	test.effect('gitlinks count as zero bytes', () =>
		Effect.gen(function* () {
			const repo = createRepo()
			repo.write('a', 'x')
			const base = repo.commit()
			repo.git('update-index', '--add', '--cacheinfo', `160000,${base},module`)
			repo.git('commit', '-m', 'gitlink')
			expect(
				(yield* GitService.use(git => git.readChange(base, 'HEAD')).pipe(
					Effect.provide(gitLayer(repo.root))
				)).files
			).toContainEqual(
				expect.objectContaining({ path: 'module', sizeBytes: 0 })
			)
		})
	)
	for (const entries of [
		[],
		[
			{
				mode: '100644',
				type: 'blob',
				object: 'abc',
				name: 'a',
				size: undefined,
			},
		],
	])
		test.effect(
			`missing tree entries or blob sizes fail instead of becoming zero: ${JSON.stringify(entries)}`,
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					repo.write('a', 'old')
					const base = repo.commit()
					repo.write('a', 'new')
					repo.commit()
					const parseLsTreeSpy = vi
						.spyOn(Domain, 'parseLsTree')
						.mockReturnValue(entries)
					const failure = yield* GitService.use(git =>
						git.readChange(base, 'HEAD')
					).pipe(Effect.provide(gitLayer(repo.root)), Effect.flip)
					expect(parseLsTreeSpy).toHaveBeenCalled()
					expect(failure).toMatchObject({ _tag: 'GitError' })
					if (failure._tag === 'GitError')
						expect(failure.stderr).toBe(
							entries.length === 0
								? 'no tree entry for a'
								: 'no blob size for a (blob)'
						)
				})
		)
	test.effect(
		'foldLines streams a blob line by line with each line cut to the cap',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				const lines = Array.from(
					{ length: 50_000 },
					(_, index) => `line ${index}`
				)
				repo.write('big.txt', `${'x'.repeat(100_000)}\n${lines.join('\n')}\n`)
				const commit = repo.commit()
				yield* Effect.gen(function* () {
					const git = yield* GitService
					const lineSpy = vi.fn((count: number, line: string) => {
						expect(line.length).toBeLessThanOrEqual(10)
						return count + 1
					})
					expect(
						yield* git.foldLines(['show', `${commit}:big.txt`], {
							initial: 0,
							maxLineChars: 10,
							step: lineSpy,
						})
					).toEqual({ exitCode: 0, stderr: '', state: 50_001 })
					expect(lineSpy.mock.calls[0]?.[1]).toBe('x'.repeat(10))
					expect(
						yield* git.foldLines(['show', `${commit}:missing.txt`], {
							initial: 0,
							maxLineChars: 10,
							step: count => count + 1,
						})
					).toMatchObject({ exitCode: 128, state: 0 })
				}).pipe(Effect.provide(gitLayer(repo.root)))
			})
	)
	test.effect('not a repository fails with ConfigError', () =>
		Effect.gen(function* () {
			const repo = createRepo()
			rmSync(join(repo.root, '.git'), { recursive: true, force: true })
			expect(
				yield* GitService.pipe(Effect.provide(gitLayer(repo.root)), Effect.flip)
			).toMatchObject({ _tag: 'ConfigError' })
		})
	)
})
