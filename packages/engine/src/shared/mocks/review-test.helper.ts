import {
	buildPlan,
	type DeclaredAgent,
	type Change,
	type ReviewConfig,
} from '@mng-review/domain'
import { config, file, pr } from './domain-test.helper'

const EMPTY_FINDINGS = { findings: [] } as const
export const BILLING_PATH = 'src/billing/charge.ts'
export const MODEL = { model: 'model-a', effort: 'high' } as const
export const FINISH = {
	type: 'finish',
	reason: 'stop',
	usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } },
} as const
export const LIMITS = {
	concurrency: 1,
	tokensPerRun: 10_000,
	maxFileKb: 300,
	maxToolCalls: 5,
	maxWallTime: '1 second',
} as const
export const DIFF = `diff --git a/${BILLING_PATH} b/${BILLING_PATH}\n--- a/${BILLING_PATH}\n+++ b/${BILLING_PATH}\n@@ -1 +1 @@ export function charge0() {\n-before\n+after\n`
export const SCOPE = {
	change: {
		base: { ref: 'main', commit: 'base-tip' },
		head: { ref: 'HEAD', commit: 'head' },
		mergeBase: 'merge-base',
		files: [file(BILLING_PATH)],
	},
	pr: pr({ title: 'Adjust cents', body: 'Keep ledger entries.' }),
} as const satisfies {
	readonly change: Change
	readonly pr: ReturnType<typeof pr>
}

/** Encoded model tool call, decoded through effect/ai in the specs. */
export function toolCall(name: string, params: unknown = {}, id = name) {
	return { type: 'tool-call', id, name, params } as const
}

/** A complete model response including deterministic token usage. */
export function answer(
	name = 'report_findings',
	params: unknown = EMPTY_FINDINGS
) {
	return [toolCall(name, params), FINISH]
}

/** A validator answer with concrete source evidence. */
export function verdict(overrides: Record<string, unknown> = {}) {
	return {
		verdict: 'confirm',
		severity: 'medium',
		reason: 'The balance is charged twice.',
		evidence: [`${BILLING_PATH}:2 balance`],
		...overrides,
	}
}

/** Pure review request fixtures, without repository or model services. */
export function reviewRequest(
	cfg: ReviewConfig = config({
		models: { reviewer: [MODEL], validator: 'cross' },
	}),
	agents: readonly DeclaredAgent[] = []
) {
	return {
		rules: {
			config: cfg,
			agents,
			context: 'Invoices intentionally use integer cents.',
			memory: 'The ledger is append-only by design.',
			source: 'working tree',
		},
		pr: SCOPE.pr,
		startedAt: 0,
		planReport: {
			change: SCOPE.change,
			rulesSource: 'working tree',
			tokens: {},
			plan: buildPlan(
				{ config: cfg, agents, files: SCOPE.change.files, pr: SCOPE.pr },
				{ status: 'ok', risk: 'normal', added: [] }
			),
		},
	} as const
}

/** Two available reviewers, ordered for cross-validation. */
export const REVIEWERS = [MODEL, { model: 'model-b', effort: 'high' }] as const
