import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { layer } from '@effect/vitest'
import { CONFIG_PATH, CONTEXT_PATH, STARTER_FILES } from '@mng-review/domain'
import { Cause, Effect, Exit, Layer } from 'effect'
import {
	cleanupRepos,
	createRepo,
	runReviewCli,
} from '../shared/mocks/review-cli.helper'
import { CliExit, CONFIG_EXIT_CODE } from './cli-exit.errors'
import { INIT_NEXT_STEP } from './init.formatter'

afterEach(() => {
	cleanupRepos()
})

layer(Layer.empty, { excludeTestServices: true })('init CLI', test => {
	test.effect(
		'init succeeds without endpoint settings or model requests and writes the starter',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				const invocation = yield* runReviewCli(repo.root, ['init'])
				expect(invocation.outcome._tag).toBe('Success')
				expect(invocation.err).toBe('')
				expect(invocation.requests).toEqual([])
				for (const file of STARTER_FILES) {
					expect(readFileSync(join(repo.root, file.path), 'utf-8')).toBe(
						file.text
					)
					expect(invocation.out).toContain(file.path)
				}
				expect(invocation.out).toContain(INIT_NEXT_STEP)
			})
	)

	test.effect(
		'second run fails with CliExit code 2, the force guidance and no writes',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				expect((yield* runReviewCli(repo.root, ['init'])).outcome._tag).toBe(
					'Success'
				)
				repo.write(CONFIG_PATH, 'Keep these settings.\n')
				const invocation = yield* runReviewCli(repo.root, ['init'])
				expect(invocation.outcome._tag).toBe('Failure')
				if (Exit.isFailure(invocation.outcome)) {
					const error = Cause.squash(invocation.outcome.cause)
					expect(error).toBeInstanceOf(CliExit)
					expect(error).toMatchObject({
						code: CONFIG_EXIT_CODE,
						detail:
							'mng-review init: .mng/ already exists; pass --force to write over its files',
					})
				}
				expect(invocation.out).toBe('')
				expect(invocation.requests).toEqual([])
				expect(readFileSync(join(repo.root, CONFIG_PATH), 'utf-8')).toBe(
					'Keep these settings.\n'
				)
			})
	)

	test.effect(
		'--force overwrites starter files and preserves unrelated files',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				for (const file of STARTER_FILES) repo.write(file.path, 'Old contents.')
				repo.write('.mng/local.txt', 'Keep this.')
				const invocation = yield* runReviewCli(repo.root, ['init', '--force'])
				expect(invocation.outcome._tag).toBe('Success')
				expect(invocation.requests).toEqual([])
				expect(invocation.err).toBe('')
				for (const file of STARTER_FILES) {
					expect(readFileSync(join(repo.root, file.path), 'utf-8')).toBe(
						file.text
					)
					expect(invocation.out).toContain(`overwritten  ${file.path}`)
				}
				expect(readFileSync(join(repo.root, '.mng/local.txt'), 'utf-8')).toBe(
					'Keep this.'
				)
			})
	)

	test.effect(
		'--from-macroscope imports end to end and reports changes without a model request',
		() =>
			Effect.gen(function* () {
				const repo = createRepo()
				const source =
					'---\ntitle: Example conventions\ninput: code_object\nmodel: example-model\n---\n@/docs/rules.md\n'
				repo.write(
					'.macroscope/correctness/correctness.md',
					'Example context.\n'
				)
				repo.write('.macroscope/check-run-agents/conventions.md', source)
				repo.write('docs/rules.md', 'Example conventions.\n')
				const invocation = yield* runReviewCli(
					repo.root,
					['init', '--from-macroscope'],
					{ endpoint: 'https://api.example.test/v1' }
				)
				expect(invocation.outcome._tag).toBe('Success')
				expect(invocation.requests).toEqual([])
				expect(invocation.err).toBe('')
				expect(
					readFileSync(
						join(repo.root, '.macroscope/check-run-agents/conventions.md'),
						'utf-8'
					)
				).toBe(source)
				expect(readFileSync(join(repo.root, CONTEXT_PATH), 'utf-8')).toBe(
					'Example context.\n'
				)
				expect(
					readFileSync(join(repo.root, '.mng/agents/conventions.md'), 'utf-8')
				).toContain('kind: nit')
				expect(
					readFileSync(join(repo.root, '.mng/agents/conventions.md'), 'utf-8')
				).toContain('@/docs/rules.md\n')
				expect(invocation.out).toContain('from .macroscope/')
				expect(invocation.out).toContain('Agent kinds')
				expect(invocation.out).toContain('conventions  nit')
				for (const text of [
					'code_object became full_diff',
					'models.agents',
					'kind: nit',
				])
					expect(invocation.out.lastIndexOf(text)).toBeGreaterThan(
						invocation.out.indexOf(INIT_NEXT_STEP)
					)
			})
	)

	for (const malformed of [false, true])
		test.effect(
			`--from-macroscope rejects ${malformed ? 'malformed' : 'missing'} input with code 2 and no output files`,
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					if (malformed)
						repo.write(
							'.macroscope/check-run-agents/billing.md',
							'---\ninclude: [\n---\nCheck balances.'
						)
					const invocation = yield* runReviewCli(repo.root, [
						'init',
						'--from-macroscope',
					])
					expect(invocation.outcome._tag).toBe('Failure')
					if (Exit.isFailure(invocation.outcome)) {
						const error = Cause.squash(invocation.outcome.cause)
						expect(error).toBeInstanceOf(CliExit)
						expect(error).toMatchObject({ code: CONFIG_EXIT_CODE })
						if (error instanceof CliExit)
							expect(error.detail).toContain(
								malformed ? 'invalid YAML' : 'no .macroscope/'
							)
					}
					expect(invocation.out).toBe('')
					expect(invocation.requests).toEqual([])
					expect(existsSync(join(repo.root, '.mng'))).toBe(false)
					if (malformed)
						expect(
							readdirSync(join(repo.root, '.macroscope/check-run-agents'))
						).toEqual(['billing.md'])
				})
		)
})
