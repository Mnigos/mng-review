import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { ConfigError } from './config.errors'
import { CONFIG_PATH, DEFAULT_PRESET } from './review-config.constants'
import { parseReviewConfig } from './review-config.parser'
import type { ReviewConfig } from './review-config.schema'

/** Literal review.yml contract from docs/spec.md, independent of the implementation preset. */
const SPEC_DEFAULTS = {
	extends: 'mng:default',
	features: { reviewer: 'always', agents: 'always', verdict: 'always' },
	depth: 'auto',
	risk_paths: [],
	comments: { min_severity: 'medium', max_nits: 5, summary: true },
	limits: {
		max_runs_per_pr: 6,
		max_file_kb: 300,
		tokens_per_run: 1_500_000,
		tokens_per_pr: 5_000_000,
		concurrency: 4,
	},
	skip: {
		drafts: true,
		forks: true,
		authors: ['dependabot[bot]', 'renovate[bot]'],
		labels: ['skip-review'],
		targets: [],
		paths: [],
	},
	labels: {
		always_review: ['review'],
		depth: { quick: 'mng-review-quick', deep: 'mng-review-deep' },
	},
	disputes: { accept_intentional_up_to: 'medium', max_rounds: 1 },
	verdict: { blocking_severity: 'medium', mode: 'preview', never_approve: [] },
	models: {
		router: { model: 'gpt-6-luna', effort: 'low' },
		reviewer: [
			{ model: 'gpt-6.1-sol', effort: 'high' },
			{ model: 'claude-opus-5-5', effort: 'high' },
		],
		agents: { model: 'gpt-6.1-sol', effort: 'high' },
		validator: 'cross',
	},
} as const satisfies ReviewConfig

layer(Layer.empty)('parseReviewConfig', test => {
	for (const text of [
		undefined,
		'',
		'   \n',
		'# only a comment\n',
		'{}',
		'extends: mng:default',
	])
		test.effect(
			`uses every documented default for ${JSON.stringify(text)}`,
			() =>
				Effect.gen(function* () {
					expect(yield* parseReviewConfig(text)).toEqual(SPEC_DEFAULTS)
					expect(DEFAULT_PRESET).toEqual(SPEC_DEFAULTS)
				})
		)

	test.effect(
		'merges partial settings and replaces arrays without changing the preset',
		() =>
			Effect.gen(function* () {
				const parsed = yield* parseReviewConfig(
					'comments: {max_nits: 2}\nmodels: {router: {model: custom}}\nskip: {authors: []}'
				)
				expect(parsed.comments).toEqual({
					...DEFAULT_PRESET.comments,
					max_nits: 2,
				})
				expect(parsed.models.router).toEqual({
					...DEFAULT_PRESET.models.router,
					model: 'custom',
				})
				expect(parsed.skip.authors).toEqual([])
				expect(yield* parseReviewConfig(undefined)).toEqual(SPEC_DEFAULTS)
			})
	)

	test.effect(
		'allocates every preset array and reviewer object independently for each parse',
		() =>
			Effect.gen(function* () {
				const first = yield* parseReviewConfig(undefined)
				const second = yield* parseReviewConfig('{}')
				const presetArrays = [
					DEFAULT_PRESET.risk_paths,
					DEFAULT_PRESET.skip.authors,
					DEFAULT_PRESET.skip.labels,
					DEFAULT_PRESET.skip.targets,
					DEFAULT_PRESET.skip.paths,
					DEFAULT_PRESET.labels.always_review,
					DEFAULT_PRESET.verdict.never_approve,
					DEFAULT_PRESET.models.reviewer,
				]
				const firstArrays = [
					first.risk_paths,
					first.skip.authors,
					first.skip.labels,
					first.skip.targets,
					first.skip.paths,
					first.labels.always_review,
					first.verdict.never_approve,
					first.models.reviewer,
				]
				const secondArrays = [
					second.risk_paths,
					second.skip.authors,
					second.skip.labels,
					second.skip.targets,
					second.skip.paths,
					second.labels.always_review,
					second.verdict.never_approve,
					second.models.reviewer,
				]
				for (const [index, values] of firstArrays.entries()) {
					expect(values).not.toBe(presetArrays[index])
					expect(values).not.toBe(secondArrays[index])
				}
				expect(first.models.reviewer[0]).not.toBe(
					DEFAULT_PRESET.models.reviewer[0]
				)
				expect(first.models.reviewer[0]).not.toBe(second.models.reviewer[0])
				expect(DEFAULT_PRESET).toEqual(SPEC_DEFAULTS)
			})
	)

	test.effect(
		'normalizes a single reviewer and inherits missing effort from the first preset reviewer',
		() =>
			Effect.gen(function* () {
				expect(
					(yield* parseReviewConfig(
						'models: {reviewer: {model: claude-opus-5-5}}'
					)).models.reviewer
				).toEqual([
					{
						model: 'claude-opus-5-5',
						effort: DEFAULT_PRESET.models.reviewer[0].effort,
					},
				])
				expect(
					(yield* parseReviewConfig(
						'models: {reviewer: {model: claude-opus-5-5, effort: low}}'
					)).models.reviewer
				).toEqual([{ model: 'claude-opus-5-5', effort: 'low' }])
				expect(yield* parseReviewConfig(undefined)).toEqual(SPEC_DEFAULTS)
			})
	)

	test.effect('keeps replacement reviewer models in repository order', () =>
		Effect.gen(function* () {
			expect(
				(yield* parseReviewConfig(
					'models:\n  reviewer:\n    - {model: claude-opus-5-5, effort: low}\n    - {model: test-reviewer, effort: medium}'
				)).models.reviewer
			).toEqual([
				{ model: 'claude-opus-5-5', effort: 'low' },
				{ model: 'test-reviewer', effort: 'medium' },
			])
		})
	)

	for (const [yaml, expected] of [
		['cross', 'cross'],
		[
			'{model: claude-opus-5-5, effort: medium}',
			{ model: 'claude-opus-5-5', effort: 'medium' },
		],
	] as const)
		test.effect(`accepts validator ${yaml}`, () =>
			Effect.gen(function* () {
				expect(
					(yield* parseReviewConfig(`models: {validator: ${yaml}}`)).models
						.validator
				).toEqual(expected)
			})
		)

	for (const [yaml, path] of [
		['typo: true', 'typo'],
		['comments: {max_nit: 3}', 'comments.max_nit'],
		['models: {router: {temp: 0.2}}', 'models.router.temp'],
		['skip: {unknown: []}', 'skip.unknown'],
		['models: {nits: {model: test-model, effort: medium}}', 'models.nits'],
		['models: {fallback: null}', 'models.fallback'],
		['features: {unknown: off}', 'features.unknown'],
		['limits: {unknown: 1}', 'limits.unknown'],
		['labels: {depth: {typo: deep}}', 'labels.depth.typo'],
		['disputes: {unknown: 1}', 'disputes.unknown'],
		['verdict: {unknown: true}', 'verdict.unknown'],
		['models: {reviewer: {model: custom, temp: 1}}', 'models.reviewer.temp'],
	])
		test.effect(`rejects unknown key ${path}`, () =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(parseReviewConfig(yaml, 'rules.yml'))
				expect(error).toBeInstanceOf(ConfigError)
				expect(error.source).toBe('rules.yml')
				expect(error.reason).toContain(`unknown key "${path}"`)
				expect(error.message).toBe(`${error.source}: ${error.reason}`)
			})
		)

	for (const [yaml, path] of [
		['limits: {concurrency: 0}', 'limits.concurrency'],
		['comments: {summary: "yes"}', 'comments.summary'],
		['comments: {max_nits: 1.5}', 'comments.max_nits'],
		['features: {agents: sometimes}', 'features.agents'],
		['risk_paths: src/auth', 'risk_paths'],
		['depth: extreme', 'depth'],
		['models: {reviewer: []}', 'models.reviewer'],
		[
			'models: {reviewer: [{model: test-reviewer, effort: low}, {model: test-reviewer, effort: high}]}',
			'models.reviewer',
		],
		['models: {validator: other}', 'models.validator'],
		['models: {validator: ""}', 'models.validator'],
		['models: {validator: gpt-6.1-sol}', 'models.validator'],
		['skip: {forks: null}', 'skip.forks'],
		['extends: local', 'extends'],
		['extends: 42', 'extends'],
		[
			'models: {reviewer: [{model: custom, effort: extreme}]}',
			'models.reviewer.0.effort',
		],
		[
			'models: {validator: {model: custom, effort: extreme}}',
			'models.validator.effort',
		],
	])
		test.effect(`rejects invalid value ${yaml} and names ${path}`, () =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(parseReviewConfig(yaml))
				expect(error).toBeInstanceOf(ConfigError)
				expect(error.source).toBe(CONFIG_PATH)
				expect(error.reason).toContain(path)
			})
		)

	test.effect('reports all unknown keys as separate dotted clauses', () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				parseReviewConfig(
					'typo: true\ncomments: {max_nit: 1}\nskip: {unknown: []}'
				)
			)
			expect(error.reason.split('; ').toSorted()).toEqual(
				[
					'unknown key "typo"',
					'unknown key "comments.max_nit"',
					'unknown key "skip.unknown"',
				].toSorted()
			)
		})
	)

	test.effect('reports invalid YAML with the given source', () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				parseReviewConfig('comments: [', 'rules.yml')
			)
			expect(error).toBeInstanceOf(ConfigError)
			expect(error.source).toBe('rules.yml')
			expect(error.message).toContain('rules.yml: invalid YAML')
		})
	)

	for (const yaml of ['[]', '- item', 'true', '42', 'text'])
		test.effect(`rejects non-mapping ${yaml}`, () =>
			Effect.gen(function* () {
				expect((yield* Effect.flip(parseReviewConfig(yaml))).reason).toBe(
					'expected a mapping at the top level'
				)
			})
		)
})
