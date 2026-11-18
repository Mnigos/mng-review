import { layer } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import {
	cleanupRepos,
	REPORTED_FINDING,
	reviewRepo,
	runReviewCli,
} from '../shared/mocks/review-cli.helper'
import { CONFIG_EXIT_CODE } from './cli-exit.errors'
import { BLOCKING_EXIT_CODE } from './review.command'

const ENDPOINT = 'https://api.example.test/v1'
const decodeReport = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Struct({
			blocking: Schema.Boolean,
			endpointError: Schema.NullOr(Schema.String),
			bugs: Schema.Array(Schema.Unknown),
			agents: Schema.Array(Schema.Unknown),
			tokens: Schema.Record(
				Schema.String,
				Schema.Struct({ totalTokens: Schema.Number })
			),
		})
	)
)

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })('review CLI', test => {
	test.effect(
		'no findings exits successfully and JSON includes configured model tokens',
		() =>
			Effect.gen(function* () {
				const invocation = yield* runReviewCli(
					reviewRepo().root,
					['--base', 'main', '--no-router', '--json'],
					{ endpoint: ENDPOINT }
				)
				expect(invocation.outcome._tag).toBe('Success')
				expect(decodeReport(invocation.out)).toMatchObject({
					blocking: false,
					endpointError: null,
					bugs: [],
					tokens: { reviewer: { totalTokens: 5 } },
				})
				expect(invocation.requests).toEqual([`${ENDPOINT}/chat/completions`])
			})
	)
	for (const severity of ['low', 'medium'] as const)
		test.effect(
			`${severity} validated bug exits ${severity === 'low' ? 0 : BLOCKING_EXIT_CODE}`,
			() =>
				Effect.gen(function* () {
					const invocation = yield* runReviewCli(
						reviewRepo().root,
						['--base', 'main', '--no-router', '--json'],
						{ endpoint: ENDPOINT, findings: [REPORTED_FINDING], severity }
					)
					const blocking = severity === 'medium'
					expect(decodeReport(invocation.out).blocking).toBe(blocking)
					expect(invocation.outcome).toMatchObject(
						blocking
							? {
									_tag: 'Failure',
									cause: {
										reasons: [
											{ error: { _tag: 'CliExit', code: BLOCKING_EXIT_CODE } },
										],
									},
								}
							: { _tag: 'Success' }
					)
					expect(invocation.requests).toHaveLength(2)
					expect(decodeReport(invocation.out).bugs).toMatchObject([
						{
							severity,
							placement: blocking ? 'inline' : 'summary',
							agents: ['reviewer'],
							models: ['reviewer'],
							validation: { status: 'confirmed', model: 'reviewer' },
						},
					])
				})
		)
	test.effect(
		'text output includes the finding, validator, tokens and wall time',
		() =>
			Effect.gen(function* () {
				const invocation = yield* runReviewCli(
					reviewRepo().root,
					['--base', 'main', '--no-router'],
					{ endpoint: ENDPOINT, findings: [REPORTED_FINDING] }
				)
				for (const text of [
					'Bugs (1):',
					REPORTED_FINDING.path,
					REPORTED_FINDING.title,
					'agents: reviewer; models: reviewer; fingerprint',
					'validator (reviewer): confirmed',
					'Tokens:',
					'reviewer  10 (6 in, 4 out, 2 call(s))',
					'Wall time:',
				])
					expect(invocation.out).toContain(text)
				expect(invocation.outcome).toMatchObject({
					_tag: 'Failure',
					cause: { reasons: [{ error: { code: BLOCKING_EXIT_CODE } }] },
				})
			})
	)
	test.effect(
		'missing endpoint fails with configuration exit and no request',
		() =>
			Effect.gen(function* () {
				const invocation = yield* runReviewCli(reviewRepo().root, [
					'--base',
					'main',
					'--no-router',
				])
				expect(invocation.outcome).toMatchObject({
					_tag: 'Failure',
					cause: {
						reasons: [
							{
								error: {
									_tag: 'CliExit',
									code: CONFIG_EXIT_CODE,
									detail: 'mng-review: MNG_REVIEW_LLM_URL: is not set',
								},
							},
						],
					},
				})
				expect(invocation.out).toBe('')
				expect(invocation.requests).toHaveLength(0)
			})
	)
	test.effect('invalid configuration fails before building an endpoint', () =>
		Effect.gen(function* () {
			const repo = reviewRepo()
			repo.write('.mng/review.yml', 'comments: {min_severty: medium}')
			const invocation = yield* runReviewCli(repo.root, ['--base', 'main'])
			expect(invocation.outcome).toMatchObject({
				_tag: 'Failure',
				cause: {
					reasons: [
						{
							error: {
								code: CONFIG_EXIT_CODE,
								detail: expect.stringContaining(
									'comments.min_severty'
								) as unknown,
							},
						},
					],
				},
			})
			expect(invocation.requests).toHaveLength(0)
		})
	)
	for (const json of [false, true])
		test.effect(`gate-skipped run exits 0 without endpoint, json=${json}`, () =>
			Effect.gen(function* () {
				const invocation = yield* runReviewCli(reviewRepo().root, [
					'--base',
					'main',
					'--label',
					'skip-review',
					...(json ? ['--json'] : []),
				])
				expect(invocation.outcome._tag).toBe('Success')
				expect(invocation.out).toContain('label skip-review is in skip.labels')
				expect(invocation.requests).toHaveLength(0)
				if (json)
					expect(decodeReport(invocation.out)).toMatchObject({
						agents: [],
						bugs: [],
						tokens: {},
						endpointError: null,
					})
			})
		)
	for (const status of [500, 503, 429])
		test.effect(
			`provider ${status} gives exit 2 and reports ${status === 500 ? 'finder endpoint failure' : 'no reviewer left'}`,
			() =>
				Effect.gen(function* () {
					const invocation = yield* runReviewCli(
						reviewRepo().root,
						['--base', 'main', '--no-router', '--json'],
						{ endpoint: ENDPOINT, status }
					)
					expect(invocation.outcome).toMatchObject({
						_tag: 'Failure',
						cause: { reasons: [{ error: { code: CONFIG_EXIT_CODE } }] },
					})
					expect(decodeReport(invocation.out).endpointError).toContain(
						status === 500 ? 'reviewer:' : 'no reviewer model left:'
					)
					expect(decodeReport(invocation.out).agents).toMatchObject([
						{ status: 'failed' },
					])
					expect(invocation.requests).toHaveLength(2)
				})
		)
})
