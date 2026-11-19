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
	NodeStdio,
	NodeTerminal,
} from '@effect/platform-node-shared'
import { layer } from '@effect/vitest'
import type { RiskSignal } from '@mng-review/domain'
import { GitWorkdir } from '@mng-review/engine'
import { Cause, ConfigProvider, Effect, Exit, Layer, Schema } from 'effect'
import { Command } from 'effect/cli'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestConsole } from 'effect/testing'
import { CliExit } from './cli-exit.errors'
import { mngReviewCommand } from './mng-review.command'

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

/** Decode the CLI's JSON boundary before inspecting its public fields. */
const jsonReportSchema = Schema.Struct({
	base: Schema.Struct({ ref: Schema.String, commit: Schema.String }),
	head: Schema.Struct({ ref: Schema.String, commit: Schema.String }),
	mergeBase: Schema.String,
	rules: Schema.String,
	skipped: Schema.NullOr(Schema.String),
	risk: Schema.Struct({
		level: Schema.String,
		source: Schema.String,
		riskPaths: Schema.Array(Schema.String),
	}),
	depth: Schema.Struct({ level: Schema.String, source: Schema.String }),
	router: Schema.Struct({
		status: Schema.String,
		detail: Schema.optionalKey(Schema.String),
		added: Schema.Array(Schema.Unknown),
	}),
	runs: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			model: Schema.String,
			effort: Schema.String,
			files: Schema.Array(Schema.String),
		})
	),
	files: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			status: Schema.String,
			additions: Schema.Number,
			deletions: Schema.Number,
		})
	),
	tokens: Schema.Record(
		Schema.String,
		Schema.Struct({
			calls: Schema.Number,
			inputTokens: Schema.Number,
			cachedInputTokens: Schema.Number,
			outputTokens: Schema.Number,
			reasoningTokens: Schema.Number,
			totalTokens: Schema.Number,
		})
	),
})
const decodeReport = Schema.decodeUnknownSync(
	Schema.fromJsonString(jsonReportSchema)
)

interface CliOptions {
	readonly signals?: readonly RiskSignal[]
	readonly endpoint?: string
	readonly responseText?: string
}

/** Runs the complete CLI handler with real local services and an HTTP test layer. */
function run(root: string, args: readonly string[], options: CliOptions = {}) {
	const requests: string[] = []
	const http = HttpClient.make(request =>
		Effect.sync(() => {
			requests.push(request.url)
			return HttpClientResponse.fromWeb(
				request,
				Response.json({
					id: 'fixture',
					object: 'chat.completion',
					created: 0,
					model: 'provider-model',
					choices: [
						{
							index: 0,
							message: {
								role: 'assistant',
								content:
									options.responseText ??
									JSON.stringify({ signals: options.signals ?? [], add: [] }),
							},
							finish_reason: 'stop',
						},
					],
					usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
				})
			)
		})
	)
	const services = Layer.mergeAll(
		NodeLayer,
		ProcessLayer,
		NodeStdio.layer,
		NodeTerminal.layer,
		Layer.succeed(GitWorkdir, { cwd: root }),
		Layer.succeed(HttpClient.HttpClient, http),
		ConfigProvider.layer(
			ConfigProvider.fromEnvRecord(
				options.endpoint === undefined
					? {}
					: { MNG_REVIEW_LLM_URL: options.endpoint }
			)
		)
	)
	return Effect.gen(function* () {
		const outcome = yield* Command.runWith(mngReviewCommand, {
			version: '0.0.0',
		})(args).pipe(Effect.exit)
		return {
			outcome,
			out: (yield* TestConsole.logLines).map(String).join('\n'),
			err: (yield* TestConsole.errorLines).map(String).join('\n'),
			requests,
		}
	}).pipe(Effect.provide(services), Effect.provide(TestConsole.layer))
}

/** Committed rules and one changed file, created separately for each invocation. */
function cliRepo() {
	const repo = createRepo()
	repo.write('.mng/review.yml', 'comments: {max_nits: 3}')
	repo.write(
		'.mng/agents/auth.md',
		'---\nkind: bug\nwhen: {paths: [packages/auth/**]}\n---\n@/docs/auth.md#Rules'
	)
	repo.write(
		'docs/auth.md',
		'# Guide\n## Rules\nCheck ownership.\n## Other\nSkip this.'
	)
	repo.write('packages/auth/session.ts', 'old\n')
	const base = repo.commit()
	repo.git('checkout', '-b', 'feature')
	repo.write('packages/auth/session.ts', 'new\n')
	const head = repo.commit()
	return { ...repo, base, head }
}

layer(Layer.empty, { excludeTestServices: true })('plan CLI', test => {
	test.effect('plan --base main prints text with the configured router', () =>
		Effect.gen(function* () {
			const repo = cliRepo()
			const invocation = yield* run(repo.root, ['plan', '--base', 'main'], {
				endpoint: 'https://api.example.test/v1',
			})
			expect(invocation.outcome._tag).toBe('Success')
			expect(invocation.err).toBe('')
			for (const text of [
				'Base main',
				'Changed files: 1',
				'Risk: normal (router)',
				'Depth: balanced',
				'Will run (2):',
				'reviewer',
				'auth',
			])
				expect(invocation.out).toContain(text)
			expect(invocation.requests).toHaveLength(1)
		})
	)
	test.effect('--json prints the refs, files, runs and model tokens', () =>
		Effect.gen(function* () {
			const repo = cliRepo()
			const invocation = yield* run(
				repo.root,
				['plan', '--base', 'main', '--json'],
				{ endpoint: 'https://api.example.test/v1' }
			)
			expect(invocation.outcome._tag).toBe('Success')
			expect(invocation.err).toBe('')
			const report = decodeReport(invocation.out)
			expect(report.base).toEqual({ ref: 'main', commit: repo.base })
			expect(report.head).toEqual({ ref: 'HEAD', commit: repo.head })
			expect(report.mergeBase).toBe(repo.base)
			expect(report.skipped).toBeNull()
			expect(report.risk).toEqual({
				level: 'normal',
				source: 'router',
				riskPaths: [],
			})
			expect(report.runs.map(entry => entry.name)).toEqual(['reviewer', 'auth'])
			expect(report.files).toMatchObject([
				{
					path: 'packages/auth/session.ts',
					status: 'modified',
					additions: 1,
					deletions: 1,
				},
			])
			expect(Object.values(report.tokens)).toEqual([
				{
					calls: 1,
					inputTokens: 3,
					cachedInputTokens: 0,
					outputTokens: 2,
					reasoningTokens: 0,
					totalTokens: 5,
				},
			])
		})
	)
	test.effect(
		'risky JSON plans list both reviewer models in configured order',
		() =>
			Effect.gen(function* () {
				const repo = cliRepo()
				repo.write(
					'.mng/review.yml',
					'models:\n  reviewer:\n    - {model: reviewer-a, effort: low}\n    - {model: reviewer-b, effort: high}'
				)
				const invocation = yield* run(
					repo.root,
					['plan', '--base', 'main', '--json'],
					{
						endpoint: 'https://api.example.test/v1',
						signals: [
							{
								category: 'access',
								path: 'packages/auth/session.ts',
								reason: 'Line 1 changes the session ownership check.',
							},
						],
					}
				)
				expect(invocation.outcome._tag).toBe('Success')
				const report = decodeReport(invocation.out)
				expect(report.risk).toEqual({
					level: 'risky',
					source: 'router',
					riskPaths: [],
				})
				expect(report.depth.level).toBe('deep')
				expect(report.runs.slice(0, 2)).toMatchObject([
					{ name: 'reviewer', model: 'reviewer-a', effort: 'medium' },
					{ name: 'reviewer', model: 'reviewer-b', effort: 'high' },
				])
				expect(report.runs[2]?.name).toBe('auth')
				expect(invocation.requests).toHaveLength(1)
			})
	)
	test.effect(
		'unknown config key fails with CliExit code 2 and no plan or model request',
		() =>
			Effect.gen(function* () {
				const repo = cliRepo()
				repo.write('.mng/review.yml', 'comments: {max_nit: 2}')
				const invocation = yield* run(repo.root, ['plan', '--base', 'main'])
				expect(invocation.out).toBe('')
				if (Exit.isFailure(invocation.outcome)) {
					const failure = Cause.squash(invocation.outcome.cause)
					expect(failure).toBeInstanceOf(CliExit)
					if (failure instanceof CliExit) {
						expect(failure.detail).toContain('mng-review:')
						expect(failure.detail).toContain('comments.max_nit')
					}
				}
				expect(invocation.requests).toEqual([])
				expect(invocation.outcome).toMatchObject({
					_tag: 'Failure',
					cause: {
						reasons: [
							{
								error: {
									_tag: 'CliExit',
									code: 2,
								},
							},
						],
					},
				})
			})
	)
	for (const args of [
		['plan'],
		['review', '--base', 'main'],
		['plan', '--base', 'main', '--unknown'],
	])
		test.effect(
			`invalid arguments produce a ShowHelp error in-process: ${args.join(' ')}`,
			() =>
				Effect.gen(function* () {
					const repo = cliRepo()
					const invocation = yield* run(repo.root, args)
					expect(invocation.outcome).toMatchObject({
						_tag: 'Failure',
						cause: { reasons: [{ error: { _tag: 'ShowHelp' } }] },
					})
					expect(invocation.requests).toEqual([])
				})
		)
	test.effect(
		'--no-router uses path selection and reports its explicit fallback',
		() =>
			Effect.gen(function* () {
				const repo = cliRepo()
				const invocation = yield* run(
					repo.root,
					['plan', '--base', 'main', '--no-router', '--json'],
					{ endpoint: 'https://api.example.test/v1' }
				)
				expect(invocation.outcome._tag).toBe('Success')
				const report = decodeReport(invocation.out)
				expect(report.router).toEqual({
					status: 'failed',
					detail: 'disabled with --no-router',
					added: [],
				})
				expect(report.risk).toEqual({
					level: 'normal',
					source: 'default',
					riskPaths: [],
				})
				expect(report.runs.map(entry => entry.name)).toEqual([
					'reviewer',
					'auth',
				])
				expect(invocation.requests).toEqual([])
			})
	)
	for (const endpoint of [undefined, 'file:///tmp/endpoint', 'not a URL'])
		test.effect(
			`missing or invalid model endpoint still produces a fallback plan: ${String(endpoint)}`,
			() =>
				Effect.gen(function* () {
					const repo = cliRepo()
					const invocation = yield* run(
						repo.root,
						['plan', '--base', 'main', '--json'],
						endpoint === undefined ? {} : { endpoint }
					)
					expect(invocation.outcome._tag).toBe('Success')
					const report = decodeReport(invocation.out)
					expect(report.router).toMatchObject({
						status: 'failed',

						added: [],
					})
					expect(report.router.detail).toContain('MNG_REVIEW_LLM_URL')
					expect(report.risk.source).toBe('default')
					expect(invocation.requests).toEqual([])
				})
		)
	test.effect(
		'--rules-ref ignores invalid working-tree config, agents and imports',
		() =>
			Effect.gen(function* () {
				const repo = cliRepo()
				repo.write('.mng/review.yml', 'unknown: true')
				repo.write(
					'.mng/agents/auth.md',
					'---\nkind: invalid\n---\n@/missing.md'
				)
				repo.write('.mng/agents/untracked.md', 'not front matter')
				rmSync(join(repo.root, 'docs/auth.md'))
				const committed = yield* run(
					repo.root,
					['plan', '--base', 'main', '--rules-ref', repo.base, '--json'],
					{ endpoint: 'https://api.example.test/v1' }
				)
				expect(committed.outcome._tag).toBe('Success')
				expect(decodeReport(committed.out).rules).toBe(repo.base)
				expect(
					decodeReport(committed.out).runs.map(entry => entry.name)
				).toEqual(['reviewer', 'auth'])
				const working = yield* run(repo.root, ['plan', '--base', 'main'])
				expect(working.outcome._tag).toBe('Failure')
				expect(working.requests).toEqual([])
			})
	)
	test.effect('--label skip-review skips the whole run and the model', () =>
		Effect.gen(function* () {
			const repo = cliRepo()
			const invocation = yield* run(
				repo.root,
				['plan', '--base', 'main', '--label', 'skip-review', '--json'],
				{ endpoint: 'https://api.example.test/v1' }
			)
			expect(invocation.outcome._tag).toBe('Success')
			const report = decodeReport(invocation.out)
			expect(report.skipped).toBe('label skip-review is in skip.labels')
			expect(report.runs).toEqual([])
			expect(report.router.status).toBe('skipped')
			expect(invocation.requests).toEqual([])
		})
	)
	test.effect(
		'manual trigger forwards repeated labels, author and explicit target',
		() =>
			Effect.gen(function* () {
				const repo = cliRepo()
				repo.write(
					'.mng/review.yml',
					'features: {reviewer: manual, agents: manual}'
				)
				repo.write(
					'.mng/agents/auth.md',
					'---\nkind: bug\nwhen: {labels: [security], authors: [author-a], targets: [release]}\n---\nCheck ownership.'
				)
				const invocation = yield* run(
					repo.root,
					[
						'plan',
						'--base',
						'main',
						'--json',
						'--author',
						'author-a',
						'--target',
						'release',
						'--label',
						'other',
						'--label',
						'security',
					],
					{ endpoint: 'https://api.example.test/v1' }
				)
				expect(invocation.outcome._tag).toBe('Success')
				expect(
					decodeReport(invocation.out).runs.map(entry => entry.name)
				).toEqual(['reviewer', 'auth'])
			})
	)
	test.effect('--head selects the named commit instead of HEAD', () =>
		Effect.gen(function* () {
			const repo = cliRepo()
			repo.write('another.ts', 'later')
			repo.commit()
			const invocation = yield* run(repo.root, [
				'plan',
				'--base',
				'main',
				'--head',
				repo.head,
				'--no-router',
				'--json',
			])
			expect(invocation.outcome._tag).toBe('Success')
			const report = decodeReport(invocation.out)
			expect(report.head).toEqual({ ref: repo.head, commit: repo.head })
			expect(report.files).toHaveLength(1)
		})
	)
})
