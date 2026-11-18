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
			incomplete: Schema.NullOr(
				Schema.Struct({
					reason: Schema.String,
					unfinished: Schema.Array(Schema.String),
				})
			),
			bugs: Schema.Array(Schema.Unknown),
			agents: Schema.Array(Schema.Unknown),
			rejected: Schema.Array(Schema.Unknown),
			nits: Schema.Array(Schema.Unknown),
			depth: Schema.Struct({ level: Schema.String }),
			droppedModels: Schema.Array(
				Schema.Struct({ model: Schema.String, reason: Schema.String })
			),
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
	for (const json of [false, true])
		test.effect(
			`CLI includes kept and rejected findings with provenance and tokens, json=${
				json
			}`,
			() =>
				Effect.gen(function* () {
					const rejected = {
						...REPORTED_FINDING,
						title: 'Missing invoice ownership guard',
						line: 20,
					}
					const invocation = yield* runReviewCli(
						reviewRepo().root,
						['--base', 'main', '--no-router', ...(json ? ['--json'] : [])],
						{
							endpoint: ENDPOINT,
							respond: call => {
								if (
									call.tools?.some(
										tool => tool.function.name === 'report_findings'
									)
								)
									return { content: { findings: [REPORTED_FINDING, rejected] } }
								return {
									content: {
										verdict: JSON.stringify(call.messages).includes(
											rejected.title
										)
											? 'reject'
											: 'confirm',
										severity: 'medium',
										reason: 'Caller checks ownership.',
										evidence: ['src/billing/charge.ts:2'],
									},
								}
							},
						}
					)
					expect(invocation.outcome).toMatchObject({
						_tag: 'Failure',
						cause: { reasons: [{ error: { code: BLOCKING_EXIT_CODE } }] },
					})
					expect(invocation.err).toBe('')
					expect(invocation.calls).toHaveLength(3)
					if (json) {
						expect(decodeReport(invocation.out)).toMatchObject({
							bugs: [
								{
									title: REPORTED_FINDING.title,
									agents: ['reviewer'],
									models: ['reviewer'],
								},
							],
							rejected: [
								{
									title: rejected.title,
									reason: 'Caller checks ownership.',
									validatedBy: 'reviewer',
								},
							],
							agents: [{ name: 'reviewer', status: 'ok' }],
							tokens: { reviewer: { totalTokens: 15 } },
						})
						return
					}
					for (const text of [
						REPORTED_FINDING.title,
						REPORTED_FINDING.trigger,
						REPORTED_FINDING.impact,
						'Rejected by the validator (1):',
						rejected.title,
						'Caller checks ownership.',
						'Agents:',
						'Tokens:',
						'reviewer  15 (9 in, 6 out, 3 call(s))',
					])
						expect(invocation.out).toContain(text)
				})
		)
	test.effect(
		'partial deep endpoint failure exits 2 and retains the successful unit finding',
		() =>
			Effect.gen(function* () {
				const repo = reviewRepo(true)
				repo.write(
					'.mng/review.yml',
					'depth: deep\nmodels:\n  reviewer: {model: reviewer, effort: high}\n  validator: cross\n'
				)
				const invocation = yield* runReviewCli(
					repo.root,
					['--base', 'main', '--no-router', '--json'],
					{
						endpoint: ENDPOINT,
						respond: call => {
							if (
								call.tools?.some(
									tool => tool.function.name === 'report_findings'
								)
							)
								return JSON.stringify(call.messages).includes('charge0()')
									? { status: 500 }
									: { content: { findings: [REPORTED_FINDING] } }
							return {
								content: {
									verdict: 'confirm',
									severity: 'medium',
									reason: 'Confirmed fixture.',
									evidence: ['src/billing/charge.ts:2'],
								},
							}
						},
					}
				)
				expect(invocation.outcome).toMatchObject({
					_tag: 'Failure',
					cause: { reasons: [{ error: { code: CONFIG_EXIT_CODE } }] },
				})
				expect(decodeReport(invocation.out)).toMatchObject({
					agents: [
						{ status: 'ok', units: 2, findings: 1, endpointError: true },
					],
					bugs: [{ title: REPORTED_FINDING.title }],
					endpointError: expect.stringContaining(
						'1 of 2 units did not finish:'
					) as unknown,
				})
				expect(
					invocation.calls.filter(call =>
						call.tools?.some(tool => tool.function.name === 'report_verdict')
					)
				).toHaveLength(1)
			})
	)
	for (const severity of ['low', 'medium'] as const)
		test.effect(
			`deep dropped reviewer preserves findings and exits by ${
				severity
			} severity`,
			() =>
				Effect.gen(function* () {
					const repo = reviewRepo()
					repo.write(
						'.mng/review.yml',
						'depth: deep\nmodels:\n  reviewer: [{model: model-a, effort: high}, {model: model-b, effort: high}]\n  validator: cross\n'
					)
					const invocation = yield* runReviewCli(
						repo.root,
						['--base', 'main', '--no-router'],
						{
							endpoint: ENDPOINT,
							respond: call => {
								if (call.model === 'model-b') return { status: 503 }
								return {
									content: call.tools?.some(
										tool => tool.function.name === 'report_findings'
									)
										? { findings: [REPORTED_FINDING] }
										: {
												verdict: 'confirm',
												severity,
												reason: 'Confirmed fixture.',
												evidence: ['src/billing/charge.ts:2'],
											},
								}
							},
						}
					)
					expect(invocation.outcome).toMatchObject(
						severity === 'low'
							? { _tag: 'Success' }
							: {
									_tag: 'Failure',
									cause: { reasons: [{ error: { code: BLOCKING_EXIT_CODE } }] },
								}
					)
					expect(invocation.err).toBe('')
					for (const text of [
						'Degraded run, models dropped:',
						'model-b  unavailable (503)',
						REPORTED_FINDING.title,
						'validator (model-a): confirmed',
					])
						expect(invocation.out).toContain(text)
					expect(invocation.out).not.toContain('Endpoint error:')
					expect(
						invocation.calls
							.filter(call =>
								call.tools?.some(
									tool => tool.function.name === 'report_verdict'
								)
							)
							.map(call => call.model)
					).toEqual(['model-a'])
				})
		)
	test.effect(
		'normal reviewer fallback is reported in CLI JSON with validation on the survivor',
		() =>
			Effect.gen(function* () {
				const repo = reviewRepo()
				repo.write(
					'.mng/review.yml',
					'models:\n  reviewer: [{model: model-a, effort: high}, {model: model-b, effort: high}]\n  validator: cross\n'
				)
				const invocation = yield* runReviewCli(
					repo.root,
					['--base', 'main', '--no-router', '--json'],
					{
						endpoint: ENDPOINT,
						respond: call =>
							call.model === 'model-a'
								? { status: 429 }
								: {
										content: call.tools?.some(
											tool => tool.function.name === 'report_findings'
										)
											? { findings: [REPORTED_FINDING] }
											: {
													verdict: 'confirm',
													severity: 'medium',
													reason: 'Confirmed fixture.',
													evidence: ['src/billing/charge.ts:2'],
												},
									},
					}
				)
				expect(invocation.outcome).toMatchObject({
					_tag: 'Failure',
					cause: { reasons: [{ error: { code: BLOCKING_EXIT_CODE } }] },
				})
				expect(decodeReport(invocation.out)).toMatchObject({
					endpointError: null,
					droppedModels: [{ model: 'model-a', reason: 'rate limited (429)' }],
					agents: [{ model: 'model-b', fellBackFrom: 'model-a', status: 'ok' }],
					bugs: [{ models: ['model-b'], validation: { model: 'model-b' } }],
				})
			})
	)
	for (const depth of ['balanced', 'deep'] as const)
		test.effect(
			`both reviewer models dropped at ${depth} exits 2 with both reasons`,
			() =>
				Effect.gen(function* () {
					const repo = reviewRepo()
					repo.write(
						'.mng/review.yml',
						`depth: ${
							depth
						}\nmodels:\n  reviewer: [{model: model-a, effort: high}, {model: model-b, effort: high}]\n  validator: cross\n`
					)
					const invocation = yield* runReviewCli(
						repo.root,
						['--base', 'main', '--no-router', '--json'],
						{
							endpoint: ENDPOINT,
							respond: call => ({
								status: call.model === 'model-a' ? 429 : 503,
							}),
						}
					)
					expect(invocation.outcome).toMatchObject({
						_tag: 'Failure',
						cause: { reasons: [{ error: { code: CONFIG_EXIT_CODE } }] },
					})
					const report = decodeReport(invocation.out)
					expect(report.endpointError).toContain('no reviewer model left:')
					expect(report.endpointError).toContain('model-a rate limited (429)')
					expect(report.endpointError).toContain('model-b unavailable (503)')
					expect(report.droppedModels).toHaveLength(2)
					expect(report.bugs).toEqual([])
					expect(
						invocation.calls.some(call =>
							call.tools?.some(tool => tool.function.name === 'report_verdict')
						)
					).toBe(false)
				})
		)
	for (const [depth, risk, expectedDepth, count] of [
		['auto', 'normal', 'balanced', 1],
		['balanced', 'normal', 'balanced', 1],
		['auto', 'risky', 'deep', 2],
		['deep', 'normal', 'deep', 2],
	] as const)
		test.effect(
			`${depth} depth and ${risk} risk run ${
				count
			} reviewer models over committed units`,
			() =>
				Effect.gen(function* () {
					const repo = reviewRepo(true)
					repo.write(
						'.mng/review.yml',
						`depth: ${
							depth
						}\nmodels:\n  router: {model: router, effort: low}\n  reviewer: [{model: model-a, effort: high}, {model: model-b, effort: high}]\n  validator: cross\n`
					)
					const invocation = yield* runReviewCli(
						repo.root,
						['--base', 'main', '--json'],
						{
							endpoint: ENDPOINT,
							respond: call => ({
								content: call.tools?.some(
									tool => tool.function.name === 'route'
								)
									? { risk, add: [] }
									: { findings: [] },
							}),
						}
					)
					expect(invocation.outcome._tag).toBe('Success')
					const report = decodeReport(invocation.out)
					expect(report.depth.level).toBe(expectedDepth)
					expect(report.agents).toMatchObject(
						count === 1
							? [{ model: 'model-a', status: 'ok' }]
							: [
									{ model: 'model-a', status: 'ok', units: 2 },
									{ model: 'model-b', status: 'ok', units: 2 },
								]
					)
					expect(report.agents).toHaveLength(count)
					expect(
						invocation.calls.filter(call => call.model === 'router')
					).toHaveLength(1)
					expect(
						invocation.calls.filter(call => call.model !== 'router')
					).toHaveLength(expectedDepth === 'deep' ? 4 : 1)
					expect(report.endpointError).toBeNull()
					expect(report.droppedModels).toEqual([])
				})
		)
	for (const [stage, limit] of [
		['routing', 5],
		['finding', 10],
	] as const)
		test.effect(
			`shared token budget exhausted after ${stage} stops later provider calls`,
			() =>
				Effect.gen(function* () {
					const repo = reviewRepo()
					repo.write(
						'.mng/review.yml',
						`limits: {tokens_per_run: ${limit}}\nmodels:\n  router: {model: router, effort: low}\n  reviewer: {model: reviewer, effort: high}\n  validator: cross\n`
					)
					const invocation = yield* runReviewCli(
						repo.root,
						['--base', 'main', '--json'],
						{
							endpoint: ENDPOINT,
							respond: call => ({
								content: call.tools?.some(
									tool => tool.function.name === 'route'
								)
									? { risk: 'normal', add: [] }
									: { findings: [REPORTED_FINDING] },
							}),
						}
					)
					const report = decodeReport(invocation.out)
					expect(report.endpointError).toBeNull()
					expect(report.droppedModels).toEqual([])
					expect(report.incomplete).toEqual({
						reason: `limits.tokens_per_run (${limit}) reached`,
						unfinished:
							stage === 'routing'
								? ['reviewer']
								: ['validation of 1 finding(s)'],
					})
					expect(invocation.calls.map(call => call.model)).toEqual(
						stage === 'routing' ? ['router'] : ['router', 'reviewer']
					)
					expect(report.tokens).toMatchObject(
						stage === 'routing'
							? { router: { totalTokens: 5 } }
							: { router: { totalTokens: 5 }, reviewer: { totalTokens: 5 } }
					)
					if (stage === 'routing') {
						expect(report.agents).toMatchObject([
							{
								status: 'incomplete',
								unfinished: ['reviewer'],
								error: expect.stringContaining('token budget spent') as unknown,
							},
						])
						expect(invocation.outcome._tag).toBe('Success')
						return
					}
					expect(report.bugs).toMatchObject([
						{
							validation: {
								status: 'unvalidated',
								budgetSpent: true,
								error: expect.stringContaining('token budget spent') as unknown,
							},
						},
					])
					expect(report.blocking).toBe(true)
					expect(invocation.outcome).toMatchObject({
						_tag: 'Failure',
						cause: { reasons: [{ error: { code: BLOCKING_EXIT_CODE } }] },
					})
				})
		)
})
