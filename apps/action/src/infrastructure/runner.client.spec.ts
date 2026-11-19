import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '@effect/platform-node-shared'
import { layer } from '@effect/vitest'
import { REDACTED } from '@mng-review/engine'
import { ConfigProvider, Effect, FileSystem, Layer, Schema } from 'effect'
import { TestConsole } from 'effect/testing'
import { formatResult } from '../presentation/result.formatter'
import { eventPayload } from '../shared/mocks/pull-request-event.helper'
import { reviewReport } from '../shared/mocks/review-report.helper'
import { parsePullRequestEvent } from './pull-request-event.parser'
import {
	maskEndpoint,
	readEventText,
	repoDirConfig,
	runnerEnvironmentConfig,
	writeResult,
	writeSummary,
} from './runner.client'

const roots: string[] = []
const RunnerLayer = NodeFileSystem.layer
const decodeJson = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Unknown)
)

/** Allocates a temporary directory owned by this spec. */
function tempDirectory() {
	const root = mkdtempSync(join(tmpdir(), 'mng-action-spec-'))
	roots.push(root)
	return root
}

afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true })
})

layer(RunnerLayer)('runner client', test => {
	test.effect(
		'returns exactly the nonempty unique values registered with the runner',
		() =>
			Effect.gen(function* () {
				for (const environment of [
					{},
					{ MNG_REVIEW_LLM_URL: '  ', MNG_REVIEW_LLM_KEY: '' },
					{
						MNG_REVIEW_LLM_URL: 'https://llm.example.com',
						MNG_REVIEW_LLM_KEY: 'llm.example.com',
					},
					{
						MNG_REVIEW_LLM_URL: ' https://llm.example.com/v1 ',
						MNG_REVIEW_LLM_KEY: 'test-key',
					},
					{
						MNG_REVIEW_LLM_URL: 'not-a-url',
						MNG_REVIEW_LLM_KEY: 'first\nsecond\n',
					},
				]) {
					yield* Effect.gen(function* () {
						const masked = yield* maskEndpoint().pipe(
							Effect.provide(
								ConfigProvider.layer(ConfigProvider.fromEnvRecord(environment))
							)
						)
						expect(masked.map(value => `::add-mask::${value}`)).toEqual(
							yield* TestConsole.logLines
						)
						expect(masked).toEqual([...new Set(masked)])
						expect(masked.every(value => value.trim().length > 0)).toBeTruthy()
					}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
				}
			})
	)
	test.effect('trims the configured result path', () =>
		Effect.gen(function* () {
			expect(
				yield* runnerEnvironmentConfig.pipe(
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnvRecord({
								MNG_REVIEW_RESULT_PATH: ' /fixture/result.json ',
							})
						)
					)
				)
			).toMatchObject({ resultPath: '/fixture/result.json' })
		})
	)
	for (const resultPath of ['', '  \t\n '])
		test.effect(
			`treats a blank result path as unset: ${JSON.stringify(resultPath)}`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* runnerEnvironmentConfig.pipe(
							Effect.provide(
								ConfigProvider.layer(
									ConfigProvider.fromEnvRecord({
										MNG_REVIEW_RESULT_PATH: resultPath,
									})
								)
							)
						)
					).toHaveProperty('resultPath', undefined)
				})
		)
	test.effect('masks the bare hostname as well as the host with its port', () =>
		Effect.gen(function* () {
			const masked = yield* maskEndpoint().pipe(
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromEnvRecord({
							MNG_REVIEW_LLM_URL: 'http://inference.example.com:8080/v1',
							MNG_REVIEW_LLM_KEY: 'test-key',
						})
					)
				)
			)
			expect(masked).toEqual([
				'http://inference.example.com:8080/v1',
				'test-key',
				'http://inference.example.com:8080',
				'inference.example.com:8080',
				'inference.example.com',
			])
			expect(yield* TestConsole.logLines).toEqual(
				masked.map(value => `::add-mask::${value}`)
			)
		}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'does not write or log a result when its path is absent or empty',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const writeFileStringSpy = vi.spyOn(fs, 'writeFileString')
				for (const path of [undefined, ''])
					yield* writeResult(path, '{"private":"test-key"}')
				expect(writeFileStringSpy).not.toHaveBeenCalled()
				expect(yield* TestConsole.logLines).toEqual([])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'writes text unchanged and replaces an existing result file',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = join(tempDirectory(), 'result.json')
				const json = '{\n  "private": "test-key"\n}'
				yield* fs.writeFileString(path, 'old result must be replaced')
				yield* writeResult(path, json)
				expect(yield* fs.readFileString(path)).toBe(json)
			})
	)
	test.effect(
		'redacts escaped endpoint values in findings and model errors and omits the PR title and body',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = join(tempDirectory(), 'result.json')
				const url = 'https://llm.example.com/v1/models'
				const key = 'test-"quoted"\\key'
				const masked = yield* maskEndpoint().pipe(
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnvRecord({
								MNG_REVIEW_LLM_URL: url,
								MNG_REVIEW_LLM_KEY: key,
							})
						)
					)
				)
				expect(masked).toEqual([
					url,
					key,
					'https://llm.example.com',
					'llm.example.com',
				])
				const payload = eventPayload()
				const event = yield* parsePullRequestEvent(JSON.stringify(payload))
				const fixture = reviewReport()
				const sensitive = `Request ${url} with ${key}; retry ${url} with ${key}`
				const report = {
					...fixture,
					bugs: fixture.bugs.map(bug => ({ ...bug, trigger: sensitive })),
					agents: fixture.agents.map(agent => ({ ...agent, error: sensitive })),
					endpointError: sensitive,
				}
				yield* writeResult(
					path,
					formatResult(
						{ status: 'reviewed', event, report },
						{
							engineCommit: undefined,
							repository: 'example/project',
							eventName: 'pull_request_target',
							runId: '123',
							runAttempt: '1',
							wallMillis: 10,
							masked: masked.toReversed(),
						}
					)
				)
				const text = yield* fs.readFileString(path)
				const expected = `Request ${REDACTED} with ${REDACTED}; retry ${REDACTED} with ${REDACTED}`
				expect(decodeJson(text)).toMatchObject({
					review: {
						bugs: report.bugs.map(bug => ({ ...bug, trigger: expected })),
						agents: report.agents.map(agent => ({ ...agent, error: expected })),
						endpointError: expected,
					},
				})
				for (const value of [
					...masked,
					payload.pull_request.title,
					payload.pull_request.body,
				])
					expect(text).not.toContain(value)
				expect(text).not.toContain(JSON.stringify(key).slice(1, -1))
				expect(decodeJson(text)).toMatchObject({
					pullRequest: {
						number: event.number,
						baseSha: event.baseSha,
						headSha: event.headSha,
						target: event.pr.target,
						author: event.pr.author,
						labels: event.pr.labels,
						draft: event.pr.draft,
					},
				})
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect('reads the reviewed checkout from MNG_REVIEW_REPO_DIR', () =>
		Effect.gen(function* () {
			expect(
				yield* repoDirConfig.pipe(
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnvRecord({
								MNG_REVIEW_REPO_DIR: '/fixture/reviewed-repository',
							})
						)
					)
				)
			).toBe('/fixture/reviewed-repository')
		})
	)
	test.effect('defaults the reviewed checkout to the working directory', () =>
		Effect.gen(function* () {
			expect(
				yield* repoDirConfig.pipe(
					Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))
				)
			).toBe(process.cwd())
		})
	)
	test.effect('masks the endpoint URL, origin, host and key', () =>
		Effect.gen(function* () {
			yield* maskEndpoint().pipe(
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromEnvRecord({
							MNG_REVIEW_LLM_URL: 'https://llm.example.com/v1',
							MNG_REVIEW_LLM_KEY: 'test-key',
						})
					)
				)
			)
			expect(yield* TestConsole.logLines).toEqual([
				'::add-mask::https://llm.example.com/v1',
				'::add-mask::test-key',
				'::add-mask::https://llm.example.com',
				'::add-mask::llm.example.com',
			])
		}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect('skips empty mask values and removes duplicate forms', () =>
		Effect.gen(function* () {
			yield* maskEndpoint().pipe(
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromEnvRecord({
							MNG_REVIEW_LLM_URL: '  ',
							MNG_REVIEW_LLM_KEY: '',
						})
					)
				)
			)
			expect(yield* TestConsole.logLines).toEqual([])
			yield* maskEndpoint().pipe(
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromEnvRecord({
							MNG_REVIEW_LLM_URL: 'https://llm.example.com',
						})
					)
				)
			)
			expect(yield* TestConsole.logLines).toEqual([
				'::add-mask::https://llm.example.com',
				'::add-mask::llm.example.com',
			])
		}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect('unset environment produces no masks', () =>
		Effect.gen(function* () {
			yield* maskEndpoint().pipe(
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))
			)
			expect(yield* TestConsole.logLines).toEqual([])
		}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'malformed URL is still masked without attempting to parse an origin',
		() =>
			Effect.gen(function* () {
				yield* maskEndpoint().pipe(
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnvRecord({
								MNG_REVIEW_LLM_URL: 'not-a-url',
								MNG_REVIEW_LLM_KEY: 'test-key',
							})
						)
					)
				)
				expect(yield* TestConsole.logLines).toEqual([
					'::add-mask::not-a-url',
					'::add-mask::test-key',
				])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'splits multiline mask values into separate runner commands',
		() =>
			Effect.gen(function* () {
				yield* maskEndpoint().pipe(
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnvRecord({
								MNG_REVIEW_LLM_KEY: 'first-line\nsecond-line\n',
							})
						)
					)
				)
				expect(yield* TestConsole.logLines).toEqual([
					'::add-mask::first-line',
					'::add-mask::second-line',
				])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect('reads event text from the file system', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = join(tempDirectory(), 'event.json')
			yield* fs.writeFileString(path, '{"pull_request":{}}\n')
			expect(yield* readEventText(path)).toBe('{"pull_request":{}}\n')
		}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'missing and unreadable event paths name only GITHUB_EVENT_PATH',
		() =>
			Effect.gen(function* () {
				for (const path of [undefined, join(tempDirectory(), 'missing.json')]) {
					const error = yield* readEventText(path).pipe(Effect.flip)
					expect(error).toMatchObject({
						_tag: 'ConfigError',
						source: 'GITHUB_EVENT_PATH',
						reason:
							path === undefined ? 'is not set' : 'cannot be read (NotFound)',
					})
					if (path) expect(error.message).not.toContain(path)
				}
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'appends summaries to an existing file without replacing earlier steps',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = join(tempDirectory(), 'summary.md')
				yield* fs.writeFileString(path, 'Earlier step\n')
				yield* writeSummary(path, 'First review\n')
				yield* writeSummary(path, 'Second review\n')
				expect(yield* fs.readFileString(path)).toBe(
					'Earlier step\nFirst review\nSecond review\n'
				)
				expect(yield* TestConsole.logLines).toEqual([])
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect('creates a summary file if it does not exist', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = join(tempDirectory(), 'summary.md')
			yield* writeSummary(path, 'Review\n')
			expect(yield* fs.readFileString(path)).toBe('Review\n')
		}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect('prints the summary when no summary path is set', () =>
		Effect.gen(function* () {
			yield* writeSummary(undefined, 'Review summary\n')
			expect(yield* TestConsole.logLines).toEqual(['Review summary\n'])
		}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'reads runner defaults without using the process environment',
		() =>
			Effect.gen(function* () {
				expect(
					yield* runnerEnvironmentConfig.pipe(
						Effect.provide(
							ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))
						)
					)
				).toEqual({
					eventName: '',
					eventPath: undefined,
					summaryPath: undefined,
					engineCommit: undefined,
					resultPath: undefined,
					repository: undefined,
					runId: undefined,
					runAttempt: undefined,
				})
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
	test.effect(
		'reads runner variables and trims event name and engine commit',
		() =>
			Effect.gen(function* () {
				expect(
					yield* runnerEnvironmentConfig.pipe(
						Effect.provide(
							ConfigProvider.layer(
								ConfigProvider.fromEnvRecord({
									GITHUB_EVENT_NAME: ' pull_request_target ',
									GITHUB_EVENT_PATH: '/fixture/event.json',
									GITHUB_STEP_SUMMARY: '/fixture/summary.md',
									MNG_REVIEW_ENGINE_COMMIT: ' abc123 ',
									MNG_REVIEW_RESULT_PATH: '/fixture/result.json',
									GITHUB_REPOSITORY: ' example/project ',
									GITHUB_RUN_ID: ' 12345678901234567890 ',
									GITHUB_RUN_ATTEMPT: ' 2 ',
								})
							)
						)
					)
				).toEqual({
					eventName: 'pull_request_target',
					eventPath: '/fixture/event.json',
					summaryPath: '/fixture/summary.md',
					engineCommit: 'abc123',
					resultPath: '/fixture/result.json',
					repository: 'example/project',
					runId: '12345678901234567890',
					runAttempt: '2',
				})
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
})
