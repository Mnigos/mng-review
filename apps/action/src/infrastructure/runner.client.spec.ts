import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '@effect/platform-node-shared'
import { layer } from '@effect/vitest'
import { ConfigProvider, Effect, FileSystem, Layer } from 'effect'
import { TestConsole } from 'effect/testing'
import {
	maskEndpoint,
	readEventText,
	runnerEnvironmentConfig,
	writeSummary,
} from './runner.client'

const roots: string[] = []
const RunnerLayer = NodeFileSystem.layer

/** Allocates a temporary directory owned by this spec. */
function tempDirectory() {
	const root = mkdtempSync(join(tmpdir(), 'mng-action-spec-'))
	roots.push(root)
	return root
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true })
})

layer(RunnerLayer)('runner client', test => {
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
								})
							)
						)
					)
				).toEqual({
					eventName: 'pull_request_target',
					eventPath: '/fixture/event.json',
					summaryPath: '/fixture/summary.md',
					engineCommit: 'abc123',
				})
			}).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
	)
})
