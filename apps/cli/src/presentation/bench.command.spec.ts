import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { layer } from '@effect/vitest'
import {
	BENCH_FILE_VERSION,
	DEFAULT_LINE_WINDOW,
	EXPECTED_LABELS,
} from '@mng-review/domain'
import { Effect, Layer, Schema } from 'effect'
import {
	cleanupRepos,
	createRepo,
	type CliModelRequest,
	type CliOptions,
	REPORTED_FINDING,
	runReviewCli,
} from '../shared/mocks/review-cli.helper'
import { CONFIG_EXIT_CODE } from './cli-exit.errors'

const ENDPOINT = 'https://api.example.test/v1'
const BENCH_FILE = 'bench.yml'
const RULES =
	'depth: balanced\nlimits: {tokens_per_run: 100}\nmodels:\n  router: {model: router, effort: low}\n  reviewer: {model: reviewer, effort: high}\n  validator: cross\n'
const EXTRA_FINDING = {
	...REPORTED_FINDING,
	line: 40,
	title: 'Refund retry loses balance',
} as const
const expectedSchema = Schema.Struct({
	id: Schema.String,
	path: Schema.String,
	line: Schema.Number,
	label: Schema.Literals(EXPECTED_LABELS),
	summary: Schema.String,
})
const findingSchema = Schema.Struct({
	path: Schema.String,
	line: Schema.Number,
	title: Schema.String,
	severity: Schema.String,
})
const matchSchema = Schema.Struct({
	expected: expectedSchema,
	finding: findingSchema,
})
const scoreSchema = Schema.Struct({
	found: Schema.Array(matchSchema),
	missed: Schema.Array(expectedSchema),
	noise: Schema.Array(matchSchema),
	unmatched: Schema.Array(findingSchema),
})
const tokensSchema = Schema.Record(
	Schema.String,
	Schema.Struct({
		calls: Schema.Number,
		inputTokens: Schema.Number,
		outputTokens: Schema.Number,
		reasoningTokens: Schema.Number,
		totalTokens: Schema.Number,
	})
)
const decodeReport = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Struct({
			file: Schema.String,
			rulesSource: Schema.String,
			lineWindow: Schema.Number,
			cases: Schema.Array(
				Schema.Struct({
					id: Schema.String,
					base: Schema.String,
					head: Schema.String,
					score: scoreSchema,
					nits: Schema.Number,
					tokens: tokensSchema,
					wallMillis: Schema.Number,
					skipped: Schema.optionalKey(Schema.String),
					endpointError: Schema.optionalKey(Schema.String),
				})
			),
			totals: Schema.Struct({
				cases: Schema.Number,
				found: Schema.Number,
				missed: Schema.Number,
				noise: Schema.Number,
				unmatched: Schema.Number,
				nits: Schema.Number,
				recall: Schema.NullOr(Schema.Number),
				unmatchedPerCase: Schema.NullOr(Schema.Number),
			}),
			tokens: tokensSchema,
			wallMillis: Schema.Number,
		})
	)
)

/** Answers by offered tool, so fixtures remain deterministic under concurrent case execution. */
function respond(call: CliModelRequest) {
	if (call.tools?.some(tool => tool.function.name === 'route'))
		return { content: { risk: 'normal', add: [] } }
	if (call.tools?.some(tool => tool.function.name === 'report_findings'))
		return { content: { findings: [REPORTED_FINDING, EXTRA_FINDING] } }
	return {
		content: {
			verdict: 'confirm',
			severity: 'medium',
			reason: 'A retry applies the charge twice.',
			evidence: ['src/billing/charge.ts:2'],
		},
	}
}

const OPTIONS = { endpoint: ENDPOINT, respond } as const satisfies CliOptions
const CASE_TOKENS = {
	router: {
		calls: 1,
		inputTokens: 3,
		outputTokens: 2,
		reasoningTokens: 0,
		totalTokens: 5,
	},
	reviewer: {
		calls: 3,
		inputTokens: 9,
		outputTokens: 6,
		reasoningTokens: 0,
		totalTokens: 15,
	},
} as const
const TOTAL_TOKENS = {
	router: {
		calls: 2,
		inputTokens: 6,
		outputTokens: 4,
		reasoningTokens: 0,
		totalTokens: 10,
	},
	reviewer: {
		calls: 6,
		inputTokens: 18,
		outputTokens: 12,
		reasoningTokens: 0,
		totalTokens: 30,
	},
} as const

/** Two recorded changes use different commit pairs while the working tree stays dirty. */
function benchRepo() {
	const repo = createRepo()
	repo.write('.mng/review.yml', RULES)
	const source = `${Array.from({ length: 60 }, (_, index) => `export const amount${index} = 0`).join('\n')}\n`
	repo.write(REPORTED_FINDING.path, source)
	const base = repo.commit()
	repo.write(REPORTED_FINDING.path, source.replaceAll('= 0', '= 1'))
	const firstHead = repo.commit()
	repo.write(REPORTED_FINDING.path, source.replaceAll('= 0', '= 2'))
	const secondHead = repo.commit()
	const entry = {
		id: 'duplicate-charge',
		path: REPORTED_FINDING.path,
		line: REPORTED_FINDING.line,
		label: 'real',
		summary: 'A retry charges twice.',
	} as const
	const cases = [
		{
			id: 'checkout-timeout',
			base,
			head: firstHead,
			expected: [entry, { ...entry, id: 'missing-guard', line: 80 }],
		},
		{
			id: 'checkout-retry',
			base: firstHead,
			head: secondHead,
			expected: [{ ...entry, label: 'intentional' }],
		},
	]
	const file = { version: BENCH_FILE_VERSION, cases }
	repo.write(BENCH_FILE, JSON.stringify(file))
	repo.write(REPORTED_FINDING.path, 'uncommitted work\n')
	repo.write('notes.txt', 'untracked fixture\n')
	return { ...repo, base, firstHead, secondHead, file }
}

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })('bench CLI', test => {
	test.effect(
		'runs both changes, scores kept bugs, and succeeds regardless of missed and noisy findings',
		() =>
			Effect.gen(function* () {
				const repo = benchRepo()
				const headBefore = repo.git('rev-parse', 'HEAD')
				const statusBefore = repo.git('status', '--porcelain=v1')
				const diffBefore = repo.git('diff', '--binary')
				const filesBefore = [
					BENCH_FILE,
					REPORTED_FINDING.path,
					'.mng/review.yml',
					'notes.txt',
				].map(path => readFileSync(join(repo.root, path), 'utf-8'))
				const invocation = yield* runReviewCli(
					repo.root,
					['bench', BENCH_FILE, '--json'],
					OPTIONS
				)
				expect(invocation.outcome._tag).toBe('Success')
				const report = decodeReport(invocation.out)
				expect(report).toMatchObject({
					file: BENCH_FILE,
					rulesSource: 'working tree',
					lineWindow: DEFAULT_LINE_WINDOW,
					totals: {
						cases: 2,
						found: 1,
						missed: 1,
						noise: 1,
						unmatched: 2,
						nits: 0,
						recall: 0.5,
						unmatchedPerCase: 1,
					},
				})
				expect(
					report.cases.map(entry => [entry.id, entry.base, entry.head])
				).toEqual([
					['checkout-timeout', repo.base, repo.firstHead],
					['checkout-retry', repo.firstHead, repo.secondHead],
				])
				expect(report.cases[0]?.score).toMatchObject({
					found: [
						{
							expected: { id: 'duplicate-charge' },
							finding: { title: REPORTED_FINDING.title },
						},
					],
					missed: [{ id: 'missing-guard' }],
					noise: [],
					unmatched: [{ title: EXTRA_FINDING.title }],
				})
				expect(report.cases[1]?.score).toMatchObject({
					found: [],
					missed: [],
					noise: [{ expected: { label: 'intentional' } }],
					unmatched: [{ title: EXTRA_FINDING.title }],
				})
				expect(report.cases.every(entry => entry.wallMillis >= 0)).toBeTruthy()
				expect(report.wallMillis).toBeGreaterThanOrEqual(0)
				expect(invocation.requests).toEqual(
					Array.from({ length: 8 }, () => `${ENDPOINT}/chat/completions`)
				)
				expect(repo.git('rev-parse', 'HEAD')).toBe(headBefore)
				expect(repo.git('status', '--porcelain=v1')).toBe(statusBefore)
				expect(repo.git('diff', '--binary')).toBe(diffBefore)
				expect(
					[
						BENCH_FILE,
						REPORTED_FINDING.path,
						'.mng/review.yml',
						'notes.txt',
					].map(path => readFileSync(join(repo.root, path), 'utf-8'))
				).toEqual(filesBefore)
			})
	)
	test.effect(
		'text mode prints case scores and totals on a completed run',
		() =>
			Effect.gen(function* () {
				const invocation = yield* runReviewCli(
					benchRepo().root,
					['bench', BENCH_FILE],
					OPTIONS
				)
				expect(invocation.outcome._tag).toBe('Success')
				expect(invocation.out).toContain('checkout-timeout  real 1/2 found')
				expect(invocation.out).toContain('checkout-retry  real 0/0 found')
				expect(invocation.out).toContain('Recall: 50.0% (1 of 2 real)')
			})
	)
	test.effect(
		'kept nits are counted separately and never match expected bugs',
		() =>
			Effect.gen(function* () {
				const repo = benchRepo()
				repo.write('.mng/review.yml', `${RULES}features: {reviewer: off}\n`)
				repo.write(
					'.mng/agents/style.md',
					'---\nkind: nit\nmodel: nit-model\nwhen: {paths: ["src/billing/**"]}\n---\nCheck the changed naming.\n'
				)
				const invocation = yield* runReviewCli(
					repo.root,
					['bench', BENCH_FILE, '--case', 'checkout-timeout', '--json'],
					OPTIONS
				)
				expect(invocation.outcome._tag).toBe('Success')
				const report = decodeReport(invocation.out)
				expect(report.cases[0]).toMatchObject({
					nits: 2,
					score: {
						found: [],
						missed: [{ id: 'duplicate-charge' }, { id: 'missing-guard' }],
						noise: [],
						unmatched: [],
					},
				})
				expect(report.totals).toMatchObject({
					nits: 2,
					found: 0,
					missed: 2,
					recall: 0,
				})
				expect(
					invocation.calls.some(call =>
						call.tools?.some(tool => tool.function.name === 'report_verdict')
					)
				).toBe(false)
			})
	)
	test.effect(
		'a model dropped in the first case remains available in the second case',
		() =>
			Effect.gen(function* () {
				const invocation = yield* runReviewCli(
					benchRepo().root,
					['bench', BENCH_FILE, '--json'],
					{
						endpoint: ENDPOINT,
						respond: call =>
							call.model === 'reviewer' &&
							JSON.stringify(call.messages).includes(
								'+export const amount0 = 1'
							)
								? { status: 503 }
								: respond(call),
					}
				)
				expect(invocation.outcome).toMatchObject({
					_tag: 'Failure',
					cause: { reasons: [{ error: { code: CONFIG_EXIT_CODE } }] },
				})
				const report = decodeReport(invocation.out)
				expect(report.cases[0]?.endpointError).toContain(
					'no reviewer model left:'
				)
				expect(report.cases[1]?.endpointError).toBeUndefined()
				expect(report.cases[1]?.score.noise).toHaveLength(1)
			})
	)

	test.effect.fails(
		'each case has an independent token ledger and totals count every response once',
		() =>
			Effect.gen(function* () {
				const invocation = yield* runReviewCli(
					benchRepo().root,
					['bench', BENCH_FILE, '--json'],
					OPTIONS
				)
				expect(invocation.outcome._tag).toBe('Success')
				expect(invocation.requests).toHaveLength(8)
				const report = decodeReport(invocation.out)
				expect({
					cases: report.cases.map(entry => entry.tokens),
					tokens: report.tokens,
				}).toEqual({ cases: [CASE_TOKENS, CASE_TOKENS], tokens: TOTAL_TOKENS })
			})
	)
	test.effect.fails(
		'each case receives the full token budget regardless of case concurrency',
		() =>
			Effect.gen(function* () {
				const repo = benchRepo()
				repo.write(
					'.mng/review.yml',
					RULES.replace('tokens_per_run: 100', 'tokens_per_run: 21')
				)
				const sequential = yield* runReviewCli(
					repo.root,
					['bench', BENCH_FILE, '--concurrency', '1', '--json'],
					OPTIONS
				)
				const concurrent = yield* runReviewCli(
					repo.root,
					['bench', BENCH_FILE, '--concurrency', '2', '--json'],
					OPTIONS
				)
				expect(sequential.outcome._tag).toBe('Success')
				expect(concurrent.outcome._tag).toBe('Success')
				expect(decodeReport(sequential.out).totals).toEqual({
					cases: 2,
					found: 1,
					missed: 1,
					noise: 1,
					unmatched: 2,
					nits: 0,
					recall: 0.5,
					unmatchedPerCase: 1,
				})
				expect(decodeReport(concurrent.out).totals).toEqual(
					decodeReport(sequential.out).totals
				)
				expect(sequential.requests).toHaveLength(8)
				expect(concurrent.requests).toHaveLength(8)
			})
	)

	test.effect(
		'--case runs only the selected case with its own tokens and totals',
		() =>
			Effect.gen(function* () {
				const invocation = yield* runReviewCli(
					benchRepo().root,
					['bench', BENCH_FILE, '--case', 'checkout-retry', '--json'],
					OPTIONS
				)
				expect(invocation.outcome._tag).toBe('Success')
				const report = decodeReport(invocation.out)
				expect(report.cases.map(entry => entry.id)).toEqual(['checkout-retry'])
				expect(report.totals).toEqual({
					cases: 1,
					found: 0,
					missed: 0,
					noise: 1,
					unmatched: 1,
					nits: 0,
					recall: null,
					unmatchedPerCase: 1,
				})
				expect(report.tokens).toEqual(CASE_TOKENS)
				expect(invocation.requests).toHaveLength(4)
			})
	)
	test.effect('repeatable --case keeps file order rather than flag order', () =>
		Effect.gen(function* () {
			const invocation = yield* runReviewCli(
				benchRepo().root,
				[
					'bench',
					BENCH_FILE,
					'--case',
					'checkout-retry',
					'--case',
					'checkout-timeout',
					'--json',
				],
				OPTIONS
			)
			expect(invocation.outcome._tag).toBe('Success')
			expect(decodeReport(invocation.out).cases.map(entry => entry.id)).toEqual(
				['checkout-timeout', 'checkout-retry']
			)
		})
	)
	test.effect(
		'--rules-ref reads committed rules and ignores invalid working tree rules',
		() =>
			Effect.gen(function* () {
				const repo = benchRepo()
				repo.write('.mng/review.yml', 'unknown_setting: invalid\n')
				repo.write('.mng/agents/broken.md', 'not an agent')
				const invocation = yield* runReviewCli(
					repo.root,
					['bench', BENCH_FILE, '--rules-ref', repo.base, '--json'],
					OPTIONS
				)
				expect(invocation.outcome._tag).toBe('Success')
				expect(decodeReport(invocation.out)).toMatchObject({
					rulesSource: repo.base,
					totals: { cases: 2, found: 1 },
				})
				expect(readFileSync(join(repo.root, '.mng/review.yml'), 'utf-8')).toBe(
					'unknown_setting: invalid\n'
				)
				expect(repo.git('rev-parse', 'HEAD')).toBe(repo.secondHead)
			})
	)
	test.effect(
		'case labels reach the gate and a skipped case makes no model request',
		() =>
			Effect.gen(function* () {
				const repo = benchRepo()
				repo.write(
					BENCH_FILE,
					JSON.stringify({
						...repo.file,
						cases: repo.file.cases.map(entry => ({
							...entry,
							labels: ['skip-review'],
						})),
					})
				)
				const invocation = yield* runReviewCli(repo.root, [
					'bench',
					BENCH_FILE,
					'--json',
				])
				expect(invocation.outcome._tag).toBe('Success')
				const report = decodeReport(invocation.out)
				expect(report.cases).toHaveLength(2)
				for (const entry of report.cases) {
					expect(entry.skipped).toBe('label skip-review is in skip.labels')
					expect(entry.tokens).toEqual({})
					expect(entry.endpointError).toBeUndefined()
				}
				expect(invocation.requests).toEqual([])
				expect(report.tokens).toEqual({})
			})
	)
	test.effect('--concurrency 2 produces the same scores as 1', () =>
		Effect.gen(function* () {
			const repo = benchRepo()
			const sequential = yield* runReviewCli(
				repo.root,
				['bench', BENCH_FILE, '--concurrency', '1', '--json'],
				OPTIONS
			)
			const concurrent = yield* runReviewCli(
				repo.root,
				['bench', BENCH_FILE, '--concurrency', '2', '--json'],
				OPTIONS
			)
			expect(sequential.outcome._tag).toBe('Success')
			expect(concurrent.outcome._tag).toBe('Success')
			const first = decodeReport(sequential.out)
			const second = decodeReport(concurrent.out)
			expect(second.cases.map(({ id, score }) => ({ id, score }))).toEqual(
				first.cases.map(({ id, score }) => ({ id, score }))
			)
			expect(second.totals).toEqual(first.totals)
		})
	)
	for (const [name, args, detail] of [
		['unknown case', ['--case', 'missing-case'], 'missing-case'],
		[
			'negative line window',
			['--line-window', '-1'],
			'--line-window must be 0 or more',
		],
		[
			'zero concurrency',
			['--concurrency', '0'],
			'--concurrency must be 1 or more',
		],
	] as const)
		test.effect(`${name} exits 2 before model requests`, () =>
			Effect.gen(function* () {
				const invocation = yield* runReviewCli(
					benchRepo().root,
					['bench', BENCH_FILE, ...args],
					OPTIONS
				)
				expect(invocation.outcome).toMatchObject({
					_tag: 'Failure',
					cause: {
						reasons: [
							{
								error: {
									_tag: 'CliExit',
									code: CONFIG_EXIT_CODE,
									detail: expect.stringContaining(detail) as unknown,
								},
							},
						],
					},
				})
				expect(invocation.requests).toEqual([])
				expect(invocation.out).toBe('')
			})
		)
	test.effect('missing endpoint exits 2 without a model request', () =>
		Effect.gen(function* () {
			const invocation = yield* runReviewCli(benchRepo().root, [
				'bench',
				BENCH_FILE,
			])
			expect(invocation.outcome).toMatchObject({
				_tag: 'Failure',
				cause: {
					reasons: [
						{
							error: {
								code: CONFIG_EXIT_CODE,
								detail: expect.stringContaining(
									'MNG_REVIEW_LLM_URL'
								) as unknown,
							},
						},
					],
				},
			})
			expect(invocation.requests).toEqual([])
			expect(invocation.out).toBe('')
		})
	)
	test.effect('missing bench file exits 2 naming the file', () =>
		Effect.gen(function* () {
			const invocation = yield* runReviewCli(
				benchRepo().root,
				['bench', 'missing.yml'],
				OPTIONS
			)
			expect(invocation.outcome).toMatchObject({
				_tag: 'Failure',
				cause: {
					reasons: [
						{
							error: {
								code: CONFIG_EXIT_CODE,
								detail: expect.stringContaining('missing.yml') as unknown,
							},
						},
					],
				},
			})
			expect(invocation.requests).toEqual([])
		})
	)
	for (const field of ['base', 'head'] as const)
		test.effect(`unknown ${field} commit exits 2 without a request`, () =>
			Effect.gen(function* () {
				const repo = benchRepo()
				repo.write(
					BENCH_FILE,
					JSON.stringify({
						...repo.file,
						cases: repo.file.cases.map(entry => ({
							...entry,
							[field]: 'unknown-commit',
						})),
					})
				)
				const invocation = yield* runReviewCli(
					repo.root,
					['bench', BENCH_FILE],
					OPTIONS
				)
				expect(invocation.outcome).toMatchObject({
					_tag: 'Failure',
					cause: {
						reasons: [
							{
								error: {
									code: CONFIG_EXIT_CODE,
									detail: expect.stringContaining('unknown-commit') as unknown,
								},
							},
						],
					},
				})
				expect(invocation.requests).toEqual([])
			})
		)
	test.effect(
		'HTTP 500 exits 2 and still prints a decodable report for every case',
		() =>
			Effect.gen(function* () {
				const invocation = yield* runReviewCli(
					benchRepo().root,
					['bench', BENCH_FILE, '--json'],
					{
						endpoint: ENDPOINT,
						respond: call =>
							call.model === 'router' ? respond(call) : { status: 500 },
					}
				)
				expect(invocation.outcome).toMatchObject({
					_tag: 'Failure',
					cause: { reasons: [{ error: { code: CONFIG_EXIT_CODE } }] },
				})
				const report = decodeReport(invocation.out)
				expect(report.cases).toHaveLength(2)
				for (const entry of report.cases) {
					expect(entry.endpointError).toContain('reviewer:')
					expect(entry.score.found).toEqual([])
				}
				expect(report.totals).toMatchObject({
					cases: 2,
					found: 0,
					missed: 2,
					recall: 0,
				})
				expect(
					invocation.calls.filter(call => call.model === 'reviewer')
				).toHaveLength(4)
			})
	)
})
