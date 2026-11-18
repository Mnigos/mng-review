import { execFileSync } from 'node:child_process'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
	symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	NodeChildProcessSpawner,
	NodeFileSystem,
	NodePath,
} from '@effect/platform-node-shared'
import { layer } from '@effect/vitest'
import { applyFileSkips } from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import {
	GitService,
	GitServiceLive,
	GitWorkdir,
} from '../../../../platform/git/git.service'
import { config, pr } from '../../../../shared/mocks/domain-test.helper'
import {
	MAX_GREP_LINES,
	MAX_TOOL_OUTPUT_CHARS,
} from '../../domain/review.constants'
import { ReviewLimits } from '../review-limits.context'
import { RepoToolsService, RepoToolsServiceLive } from './repo-tools.service'

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

/** Committed content differs from the worktree and the advanced base branch. */
function fixture() {
	const repo = createRepo()
	repo.write('src/billing/charge.ts', 'base one\nbase two\nbase three')
	repo.write('README.md', 'base readme')
	const base = repo.commit()
	repo.git('checkout', '-b', 'feature')
	repo.write('src/billing/charge.ts', 'head one\n-option\nhead three')
	repo.write('README.md', 'head readme')
	repo.write('-option.txt', 'option file')
	repo.write('large.txt', `${'x'.repeat(1200)}\nlast line`)
	repo.write('data.bin', new Uint8Array([65, 0, 66]))
	repo.write('ignored.txt', 'excluded content')
	const outside = createRepo()
	outside.write('private.txt', 'outside target must never be read')
	symlinkSync(
		join(outside.root, 'private.txt'),
		join(repo.root, 'external-link')
	)
	repo.commit()
	repo.git('checkout', 'main')
	repo.write('README.md', 'advanced base must not appear')
	repo.commit()
	repo.git('checkout', 'feature')
	repo.write('README.md', 'working tree must not appear')
	return { ...repo, base, outside }
}

/** Real git, with file-size limits and no model service. */
function toolsLayer(root: string) {
	return RepoToolsServiceLive.pipe(
		Layer.provideMerge(gitLayer(root)),
		Layer.provide(
			Layer.succeed(ReviewLimits, {
				concurrency: 2,
				tokensPerRun: 100,
				maxFileKb: 1,
				maxToolCalls: 5,
				maxWallTime: '1 second',
			})
		)
	)
}

/** Reads the real change and applies the same exclusions as the review plan. */
const scope = Effect.gen(function* () {
	const change = yield* GitService.use(git => git.readChange('main', 'HEAD'))
	return {
		change: {
			...change,
			files: applyFileSkips(
				change.files,
				config({ limits: { max_file_kb: 1 }, skip: { paths: ['ignored.txt'] } })
			),
		},
		pr: pr({
			title: 'Adjust charge',
			body: 'Review cents',
			labels: ['review'],
		}),
	}
})

layer(Layer.empty, { excludeTestServices: true })('RepoToolsService', test => {
	for (const ref of ['head', 'base'] as const)
		test.effect(`read_file numbers committed ${ref} files and ranges`, () =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					const tools = yield* RepoToolsService
					const prefix = ref === 'head' ? 'head' : 'base'
					const second = ref === 'head' ? '-option' : 'base two'
					expect(
						yield* tools.call(input, 'read_file', {
							ref,
							path: 'src/billing/charge.ts',
						})
					).toBe(`1| ${prefix} one\n2| ${second}\n3| ${prefix} three`)
					expect(
						yield* tools.call(input, 'read_file', {
							ref,
							path: 'src/billing/charge.ts',
							range: ' 2 - 3 ',
						})
					).toBe(`2| ${second}\n3| ${prefix} three`)
					expect(
						yield* tools.call(input, 'read_file', {
							ref,
							path: 'src/billing/charge.ts',
							range: '3',
						})
					).toBe(`3| ${prefix} three`)
					expect(
						yield* tools.call(input, 'read_file', {
							ref,
							path: 'src/billing/charge.ts',
							range: '50-60',
						})
					).toBe('(no lines in range)')
					expect(
						yield* tools.call(input, 'read_file', { path: './README.md' })
					).toBe('1| head readme')
					expect(
						yield* tools.call(input, 'read_file', {
							ref: 'base',
							path: 'README.md',
						})
					).toBe('1| base readme')
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
		)
	for (const range of ['bad', '3-1', '-1', '1:2', 5])
		test.effect(`malformed range ${range} is error text`, () =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					expect(
						yield* RepoToolsService.use(tools =>
							tools.call(input, 'read_file', { path: 'README.md', range })
						)
					).toMatch(/^error: /u)
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
		)
	for (const path of [
		'../x',
		'/etc/passwd',
		'a/../../x',
		'src\\billing\\charge.ts',
		'src\0x',
	])
		test.effect(
			`confines path ${JSON.stringify(path)} for every file tool`,
			() =>
				Effect.gen(function* () {
					const repo = fixture()
					yield* Effect.gen(function* () {
						const input = yield* scope
						const tools = yield* RepoToolsService
						for (const name of ['read_file', 'list_dir', 'diff', 'blame'])
							expect(
								yield* tools.call(input, name, { path, range: '1' })
							).toMatch(/^error: /u)
					}).pipe(Effect.provide(toolsLayer(repo.root)))
				})
		)
	for (const ref of ['main', 'feature', '--output=x', '', 7, 'HEAD'])
		test.effect(`rejects ref ${JSON.stringify(ref)}`, () =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					const tools = yield* RepoToolsService
					for (const name of ['read_file', 'grep', 'list_dir'])
						expect(
							yield* tools.call(input, name, {
								ref,
								path: 'README.md',
								pattern: 'readme',
							})
						).toMatch(/^error: /u)
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
		)
	for (const glob of ['../*', 'src/../*', '/src/*', 'src\\*', 'src\0*'])
		test.effect(`rejects glob ${JSON.stringify(glob)}`, () =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					expect(
						yield* RepoToolsService.use(tools =>
							tools.call(input, 'grep', { pattern: 'head', glob })
						)
					).toContain('error: glob must be a repository-relative pattern')
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
		)
	test.effect(
		'missing, binary, oversized and symlink blobs are handled without following links',
		() =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					const tools = yield* RepoToolsService
					expect(
						yield* tools.call(input, 'read_file', { path: 'missing.ts' })
					).toContain('error: missing.ts does not exist')
					expect(
						yield* tools.call(input, 'read_file', { path: 'data.bin' })
					).toContain('binary file')
					expect(
						yield* tools.call(input, 'read_file', { path: 'large.txt' })
					).toContain('pass a range')
					expect(
						yield* tools.call(input, 'read_file', {
							path: 'large.txt',
							range: '2',
						})
					).toBe('2| last line')
					expect(
						yield* tools.call(input, 'read_file', { path: 'external-link' })
					).toBe(`1| ${join(repo.outside.root, 'private.txt')}`)
					expect(
						yield* tools.call(input, 'read_file', { path: '-option.txt' })
					).toBe('1| option file')
					expect(
						yield* tools.call(input, 'diff', { path: '-option.txt' })
					).toContain('+option file')
					expect(
						yield* tools.call(input, 'blame', {
							path: '-option.txt',
							range: '1',
						})
					).toContain('option file')
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
	)
	test.effect(
		'grep handles option-like patterns, glob filters, base, invalid regex and no matches',
		() =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					const tools = yield* RepoToolsService
					expect(
						yield* tools.call(input, 'grep', {
							pattern: '-option',
							glob: 'src/**/*.ts',
						})
					).toBe('src/billing/charge.ts:2:-option')
					expect(
						yield* tools.call(input, 'grep', {
							pattern: 'readme',
							glob: 'src/**/*.ts',
						})
					).toBe('(no matches)')
					expect(
						yield* tools.call(input, 'grep', {
							ref: 'base',
							pattern: 'base two',
						})
					).toBe('src/billing/charge.ts:2:base two')
					expect(
						yield* tools.call(input, 'grep', { pattern: 'not-present' })
					).toBe('(no matches)')
					expect(yield* tools.call(input, 'grep', { pattern: '[' })).toMatch(
						/^error: /u
					)
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
	)
	test.effect(
		'list_dir lists root and nested names with directory slashes',
		() =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					const tools = yield* RepoToolsService
					expect(
						(yield* tools.call(input, 'list_dir', {})).split('\n')
					).toContain('src/')
					expect(
						(yield* tools.call(input, 'list_dir', { path: '.' })).split('\n')
					).toContain('README.md')
					expect(yield* tools.call(input, 'list_dir', { path: 'src' })).toBe(
						'billing/'
					)
					expect(
						yield* tools.call(input, 'list_dir', {
							ref: 'base',
							path: 'src/billing',
						})
					).toBe('charge.ts')
					expect(
						yield* tools.call(input, 'list_dir', { path: 'missing' })
					).toMatch(/^error: /u)
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
	)
	test.effect(
		'diff excludes skipped paths globally and explicitly, and handles empty changes',
		() =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					const tools = yield* RepoToolsService
					const diff = yield* tools.call(input, 'diff', {})
					expect(diff).toContain('diff --git a/README.md b/README.md')
					expect(diff).toContain(
						'diff --git a/src/billing/charge.ts b/src/billing/charge.ts'
					)
					for (const path of ['ignored.txt', 'large.txt', 'data.bin']) {
						expect(diff).not.toContain(`diff --git a/${path}`)
						expect(yield* tools.call(input, 'diff', { path })).toMatch(
							/^error: /u
						)
					}
					expect(
						yield* tools.call(input, 'diff', { path: 'README.md' })
					).toContain('+head readme')
					expect(yield* tools.call(input, 'diff', { path: 'missing' })).toBe(
						'(no changes)'
					)
					expect(
						yield* tools.call(
							{ ...input, change: { ...input.change, files: [] } },
							'diff',
							{}
						)
					).toBe('(no reviewable files)')
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
	)
	for (const path of [undefined, 'src/billing/charge.ts'])
		for (const offset of [15_000, '15000'])
			test.effect(
				`diff pages ${path ?? 'all files'} with offset ${typeof offset}`,
				() =>
					Effect.gen(function* () {
						const repo = fixture()
						repo.write('src/billing/charge.ts', 'changed line\n'.repeat(5000))
						repo.commit()
						yield* Effect.gen(function* () {
							const input = {
								change: yield* GitService.use(git =>
									git.readChange('main', 'HEAD')
								),
								pr: pr(),
							}
							const tools = yield* RepoToolsService
							const git = yield* GitService
							const files = input.change.files.filter(
								file =>
									!file.skipped && (path === undefined || file.path === path)
							)
							const whole = yield* git.readDiff(input.change, files)
							expect(whole.length).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS * 2)
							const part = yield* tools.call(input, 'diff', {
								...(path === undefined ? {} : { path }),
								offset,
							})
							const marker =
								/\n\[more: call diff again with offset=(\d+)\]$/u.exec(part)
							expect(marker).not.toBeNull()
							expect(part.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS)
							expect(part.slice(0, marker?.index)).toBe(
								whole.slice(Number(offset), Number(marker?.[1]))
							)
							expect(
								yield* tools.call(input, 'diff', {
									...(path === undefined ? {} : { path }),
									offset: whole.length + 1,
								})
							).toBe(`(no more output; it ends at offset ${whole.length})`)
						}).pipe(Effect.provide(toolsLayer(repo.root)))
					})
			)
	test.effect('blame requires a range and returns only those lines', () =>
		Effect.gen(function* () {
			const repo = fixture()
			yield* Effect.gen(function* () {
				const input = yield* scope
				const tools = yield* RepoToolsService
				expect(
					yield* tools.call(input, 'blame', { path: 'README.md' })
				).toMatch(/^error: /u)
				const blame = yield* tools.call(input, 'blame', {
					path: 'src/billing/charge.ts',
					range: '2',
				})
				expect(blame).toContain('-option')
				expect(blame).not.toContain('head three')
			}).pipe(Effect.provide(toolsLayer(repo.root)))
		})
	)
	test.effect(
		'metadata contains PR fields, commits and skipped-file statistics',
		() =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					const metadata: unknown = JSON.parse(
						yield* RepoToolsService.use(tools =>
							tools.call(input, 'pr_metadata', {})
						)
					)
					expect(metadata).toMatchObject({
						title: 'Adjust charge',
						description: 'Review cents',
						labels: ['review'],
						author: 'author-a',
						target: 'main',
						base: 'main',
						head: 'HEAD',
					})
					expect(metadata).toMatchObject({
						commits: [expect.objectContaining({}) as unknown],
					})
					expect(metadata).toMatchObject({
						files: expect.arrayContaining([
							{
								path: 'ignored.txt',
								status: 'added',
								additions: 1,
								deletions: 0,
								left_out: 'skip.paths',
							},
						]) as unknown,
					})
					expect(metadata).toMatchObject({
						files: expect.arrayContaining([
							{
								path: 'src/billing/charge.ts',
								status: 'modified',
								additions: 3,
								deletions: 3,
							},
						]) as unknown,
					})
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
	)
	test.effect(
		'unknown tools, invalid arguments and Git failures are successful error text',
		() =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					const tools = yield* RepoToolsService
					expect(yield* tools.call(input, 'execute', {})).toBe(
						'error: unknown tool execute'
					)
					for (const params of [{}, null, [], 5])
						expect(yield* tools.call(input, 'read_file', params)).toMatch(
							/^error: /u
						)
					expect(yield* tools.call(input, 'grep', {})).toMatch(/^error: /u)
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
	)
	test.effect(
		'truncation marker stays inside the output cap and grep counts extra matches',
		() =>
			Effect.gen(function* () {
				const repo = fixture()
				for (const index of Array.from({ length: 8 }, (_, item) => item))
					repo.write(`many/${index}.txt`, 'needle\n'.repeat(50))
				repo.write('huge.txt', 'x'.repeat(MAX_TOOL_OUTPUT_CHARS * 2))
				repo.commit()
				yield* Effect.gen(function* () {
					const input = yield* scope
					const tools = yield* RepoToolsService
					const grep = yield* tools.call(input, 'grep', { pattern: 'needle' })
					expect(grep.split('\n')).toHaveLength(MAX_GREP_LINES + 1)
					expect(grep).toContain(`[${400 - MAX_GREP_LINES} more matches]`)
					const output = yield* tools.call(input, 'read_file', {
						path: 'huge.txt',
						range: '1',
					})
					expect(output.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS)
					expect(output).toContain('[truncated:')
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
	)
	test.effect(
		'error output is capped with its truncation marker inside the cap',
		() =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					const output = yield* RepoToolsService.use(tools =>
						tools.call(input, 'unknown'.repeat(MAX_TOOL_OUTPUT_CHARS), {
							path: 'missing',
						})
					)
					expect(output).toMatch(/^error: /u)
					expect(output.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS)
					expect(output).toContain('[truncated:')
					const longPath = yield* RepoToolsService.use(tools =>
						tools.call(input, 'read_file', {
							path: 'missing'.repeat(MAX_TOOL_OUTPUT_CHARS),
						})
					)
					expect(longPath).toBe('error: path is too long')
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
	)
	test.effect('blame never executes repository textconv configuration', () =>
		Effect.gen(function* () {
			const repo = fixture()
			const converter = join(repo.root, 'convert.sh')
			const marker = join(repo.root, 'textconv-ran')
			repo.write(
				'convert.sh',
				`#!/bin/sh\nprintf invoked > "${marker}"\ncat "$1"\n`
			)
			chmodSync(converter, 0o755)
			repo.write('.gitattributes', '*.ts diff=fixture\n')
			repo.git('config', 'diff.fixture.textconv', converter)
			repo.commit()
			yield* Effect.gen(function* () {
				const input = yield* scope
				expect(
					yield* RepoToolsService.use(tools =>
						tools.call(input, 'blame', {
							path: 'src/billing/charge.ts',
							range: '2',
						})
					)
				).toContain('-option')
				expect(existsSync(marker)).toBe(false)
			}).pipe(Effect.provide(toolsLayer(repo.root)))
		})
	)
	test.effect(
		'grep with an empty pattern returns its required-pattern error',
		() =>
			Effect.gen(function* () {
				const repo = fixture()
				yield* Effect.gen(function* () {
					const input = yield* scope
					expect(
						yield* RepoToolsService.use(tools =>
							tools.call(input, 'grep', { pattern: '' })
						)
					).toBe('error: pattern is required')
				}).pipe(Effect.provide(toolsLayer(repo.root)))
			})
	)
})
