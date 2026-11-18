import { DEFAULT_PRESET, type Plan, type PlannedRun } from '@mng-review/domain'
import type { PlanReport } from '@mng-review/engine'
import { formatPlanJson, formatPlanText } from './plan.formatter'

const RUN = {
	name: 'auth',
	title: 'Ownership',
	role: 'agent',
	kind: 'bug',
	input: 'full_diff',
	model: 'reviewer-a',
	effort: 'high',
	files: ['src/auth.ts'],
	selectedBy: 'router',
	reason: 'Touches ownership.',
} as const satisfies PlannedRun

/** A report with every presentation branch independent of git or a model. */
function report(overrides: Partial<Plan> = {}): PlanReport {
	return {
		change: {
			base: { ref: 'main', commit: '1234567890' },
			head: { ref: 'HEAD', commit: 'abcdef1234' },
			mergeBase: '2345678901',
			files: [
				{
					path: 'generated/a.ts',
					status: 'modified',
					additions: 1,
					deletions: 0,
					binary: false,
					sizeBytes: 100,
					skipped: 'skip.paths',
				},
				{
					path: 'large.ts',
					status: 'added',
					additions: 1,
					deletions: 0,
					binary: false,
					sizeBytes: 1025,
					skipped: 'too_large',
				},
				{
					path: 'image.bin',
					status: 'added',
					additions: 0,
					deletions: 0,
					binary: true,
					sizeBytes: 10,
					skipped: 'binary',
				},
			],
		},
		rulesSource: 'working tree',
		tokens: {
			'router-a': {
				calls: 1,
				inputTokens: 3,
				outputTokens: 2,
				reasoningTokens: 0,
				totalTokens: 5,
			},
		},
		plan: {
			skippedRun: undefined,
			files: [],
			risk: 'risky',
			riskSource: 'risk_paths',
			riskPathHits: ['src/auth.ts'],
			depth: 'deep',
			depthSource: 'risk_paths',
			router: {
				status: 'ok',
				risk: 'risky',
				added: [{ agent: 'auth', reason: 'Touches ownership.' }],
			},
			runs: [RUN],
			skips: [{ name: 'nits', title: 'Nits', reason: 'not selected' }],
			...overrides,
		},
	}
}

test('text reports shortened refs, skip reasons, router selection, risk paths and tokens', () => {
	const text = formatPlanText(report())
	for (const expected of [
		'Base main (12345678), head HEAD (abcdef12), merge base 23456789',
		'Rules: working tree',
		'Changed files: 3, 3 left out',
		'generated/a.ts (skip.paths)',
		'large.ts (over max_file_kb, 2 KB)',
		'image.bin (binary)',
		'Risk: risky (risk_paths: src/auth.ts)',
		'Depth: deep (risk_paths)',
		'Router: ok, rated risky, added 1',
		'Will run (1):',
		'router: Touches ownership.',
		'Skipped (1):',
		'nits  not selected',
		'router-a  5 (3 in, 2 out, 1 call(s))',
	])
		expect(text).toContain(expected)
})

test('JSON keeps the public report structure and duplicate reviewer order', () => {
	const reviewers = DEFAULT_PRESET.models.reviewer.map(model => ({
		...RUN,
		name: 'reviewer',
		role: 'reviewer' as const,
		model: model.model,
	}))
	const input = report({ runs: reviewers })
	expect(formatPlanJson(input)).toBe(
		JSON.stringify(
			{
				base: input.change.base,
				head: input.change.head,
				mergeBase: input.change.mergeBase,
				rules: input.rulesSource,
				skipped: null,
				risk: {
					level: input.plan.risk,
					source: input.plan.riskSource,
					riskPaths: input.plan.riskPathHits,
				},
				depth: { level: input.plan.depth, source: input.plan.depthSource },
				router: input.plan.router,
				runs: reviewers,
				skips: input.plan.skips,
				files: input.change.files,
				tokens: input.tokens,
			},
			null,
			2
		)
	)
})

test('a skipped run prints its reason without runs or tokens and preserves it in JSON', () => {
	const input = report({
		skippedRun: 'label skip-review is in skip.labels',
		runs: [],
	})
	const text = formatPlanText(input)
	expect(text).toContain('Run skipped: label skip-review is in skip.labels')
	expect(text).not.toContain('Will run')
	expect(text).not.toContain('Tokens:')
	expect(formatPlanJson(input)).toContain(
		'"skipped": "label skip-review is in skip.labels"'
	)
})

test('empty runs, absent tokens and unavailable router are explicit', () => {
	const text = formatPlanText({
		...report({
			runs: [],
			skips: [],
			risk: 'normal',
			riskSource: 'default',
			router: { status: 'failed', detail: 'no model endpoint', added: [] },
		}),
		tokens: {},
	})
	expect(text).toContain('Will run (0):\n  (nothing)')
	expect(text).toContain('Router: failed: no model endpoint')
	expect(text).toContain('Risk: normal (default)')
	expect(text).not.toContain('Tokens:')
	expect(text).not.toContain('Skipped (')
})
