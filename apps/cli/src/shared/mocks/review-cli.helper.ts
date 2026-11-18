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
import { GitWorkdir } from '@mng-review/engine'
import { ConfigProvider, Effect, Layer, Schema } from 'effect'
import { Command } from 'effect/cli'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestConsole } from 'effect/testing'
import { mngReviewCommand } from '../../presentation/mng-review.command'

const roots: string[] = []
const NodeLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const ProcessLayer = NodeChildProcessSpawner.layer.pipe(
	Layer.provide(NodeLayer)
)

/** Creates an isolated repository; all fixture commands disable hooks and signing. */
export function createRepo(name = 'repo') {
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

/** Removes only fixture repositories created by this module. */
export function cleanupRepos() {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true })
}

/** The request fields the offline provider script uses to identify a conversation. */
const cliModelRequestSchema = Schema.Struct({
	model: Schema.String,
	messages: Schema.Array(
		Schema.Struct({ role: Schema.String, content: Schema.Unknown })
	),
	tools: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })
		)
	),
})
export type CliModelRequest = typeof cliModelRequestSchema.Type

/** A provider response selected by request content rather than scheduling order. */
export interface CliModelResponse {
	readonly content?: unknown
	readonly status?: number
}

export interface CliOptions {
	readonly respond?: (
		request: CliModelRequest,
		index: number
	) => CliModelResponse

	readonly endpoint?: string
	readonly findings?: readonly unknown[]
	readonly severity?: string
	readonly status?: number
}

/** Executes the real command with a provider transport fixture; no request leaves the process. */
export function runReviewCli(
	root: string,
	args: readonly string[],
	options: CliOptions = {}
) {
	const requests: string[] = []
	const calls: CliModelRequest[] = []
	const http = HttpClient.make(request =>
		Effect.gen(function* () {
			const index = requests.length
			requests.push(request.url)
			if (request.body._tag !== 'Uint8Array')
				return yield* Effect.die('Expected an encoded provider request')
			const call = Schema.decodeUnknownSync(
				Schema.fromJsonString(cliModelRequestSchema)
			)(new TextDecoder().decode(request.body.body))
			calls.push(call)
			const response = options.respond?.(call, index)
			const status = response?.status ?? options.status
			const content =
				response?.content ??
				(index === 0
					? { findings: options.findings ?? [] }
					: {
							verdict: 'confirm',
							severity: options.severity ?? 'medium',
							reason: 'The duplicate submission charges twice.',
							evidence: ['src/billing/charge.ts:2'],
						})
			return HttpClientResponse.fromWeb(
				request,
				status === undefined
					? Response.json({
							id: 'fixture',
							object: 'chat.completion',
							created: 0,
							model: 'provider-model',
							choices: [
								{
									index: 0,
									message: {
										role: 'assistant',
										content: JSON.stringify(content),
									},
									finish_reason: 'stop',
								},
							],
							usage: {
								prompt_tokens: 3,
								completion_tokens: 2,
								total_tokens: 5,
							},
						})
					: Response.json(
							{
								error: {
									message: 'fixture endpoint failure',
									type: 'server_error',
								},
							},
							{ status, headers: { 'retry-after': '0' } }
						)
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
			calls,
		}
	}).pipe(Effect.provide(services), Effect.provide(TestConsole.layer))
}

/** One changed source file and one deterministic reviewer, without routing model calls. */
export function reviewRepo(functions = false) {
	const repo = createRepo()
	repo.write(
		'.mng/review.yml',
		'models:\n  reviewer: {model: reviewer, effort: high}\n  validator: cross\n'
	)
	const before = functions
		? `${Array.from({ length: 2 }, (_, index) =>
				[
					`export function charge${index}() {`,
					...Array.from({ length: 10 }, () => '  // fixture context'),
					'  return "old"',
					'}',
				].join('\n')
			).join('\n\n')}\n`
		: 'old\n'
	repo.write('src/billing/charge.ts', before)
	repo.commit()
	repo.git('checkout', '-b', 'feature')
	repo.write('src/billing/charge.ts', before.replaceAll('old', 'new'))
	repo.commit()
	return repo
}

/** The public finding payload accepted by the review boundary. */
export const REPORTED_FINDING = {
	path: 'src/billing/charge.ts',
	line: 2,
	severity: 'medium',
	title: 'Duplicate charge loses balance',
	trigger: 'Invoice retry',
	impact: 'The balance is charged twice.',
	evidence: ['src/billing/charge.ts:2'],
} as const
