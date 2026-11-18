import type {
	AgentFrontMatter,
	AgentWhen,
} from '../../agents/agent-front-matter.schema'
import {
	DEFAULT_AGENT_INPUT,
	DEFAULT_MAX_FINDINGS,
} from '../../agents/agent.constants'
import type { DeclaredAgent } from '../../agents/agent.types'
import type { ChangedFile } from '../../change/change.types'
import { DEFAULT_PRESET } from '../../config/review-config.constants'
import type {
	ModelSetting,
	ReviewConfig,
} from '../../config/review-config.schema'
import { toFinding } from '../../findings/finding.helper'
import type { ReportedFinding } from '../../findings/finding.schema'
import type { Finding } from '../../findings/finding.types'
import type { PlannedRun, PlanInput } from '../../routing/review-plan.types'
import type { PullRequestInfo, RouterReport } from '../../routing/routing.types'

/** Nested fixture overrides retain complete reviewer and validator model entries. */
interface ConfigOverrides extends Partial<
	Omit<
		ReviewConfig,
		| 'features'
		| 'comments'
		| 'limits'
		| 'skip'
		| 'labels'
		| 'disputes'
		| 'verdict'
		| 'models'
	>
> {
	readonly features?: Partial<ReviewConfig['features']>
	readonly comments?: Partial<ReviewConfig['comments']>
	readonly limits?: Partial<ReviewConfig['limits']>
	readonly skip?: Partial<ReviewConfig['skip']>
	readonly labels?: Partial<Omit<ReviewConfig['labels'], 'depth'>> & {
		readonly depth?: Partial<ReviewConfig['labels']['depth']>
	}
	readonly disputes?: Partial<ReviewConfig['disputes']>
	readonly verdict?: Partial<ReviewConfig['verdict']>
	readonly models?: Partial<
		Omit<ReviewConfig['models'], 'router' | 'agents'>
	> & {
		readonly router?: Partial<ModelSetting>
		readonly agents?: Partial<ModelSetting>
	}
}

/** Creates an isolated preset with only the settings a case needs changed. */
export function config(overrides: ConfigOverrides = {}): ReviewConfig {
	const preset = structuredClone(DEFAULT_PRESET)
	return structuredClone({
		...preset,
		...overrides,
		features: { ...preset.features, ...overrides.features },
		comments: { ...preset.comments, ...overrides.comments },
		limits: { ...preset.limits, ...overrides.limits },
		skip: { ...preset.skip, ...overrides.skip },
		labels: {
			...preset.labels,
			...overrides.labels,
			depth: { ...preset.labels.depth, ...overrides.labels?.depth },
		},
		disputes: { ...preset.disputes, ...overrides.disputes },
		verdict: { ...preset.verdict, ...overrides.verdict },
		models: {
			...preset.models,
			...overrides.models,
			router: { ...preset.models.router, ...overrides.models?.router },
			agents: { ...preset.models.agents, ...overrides.models?.agents },
		},
	})
}

/** Front matter fixture overrides keep selection lists independent. */
interface AgentOverrides extends Partial<Omit<AgentFrontMatter, 'when'>> {
	readonly when?: Partial<AgentWhen>
}

/** Creates a declared agent without parsing files or running effects. */
export function agent(
	name = 'auth',
	overrides: AgentOverrides = {}
): DeclaredAgent {
	return {
		name,
		title: name,
		file: `.mng/agents/${name}.md`,
		instructions: 'Check changed behavior.',
		frontMatter: {
			kind: 'bug',
			input: DEFAULT_AGENT_INPUT,
			needs: [],
			max_findings: DEFAULT_MAX_FINDINGS,
			...overrides,
			when: {
				paths: [],
				exclude: [],
				labels: [],
				authors: [],
				targets: [],
				...overrides.when,
			},
		},
	}
}

/** Creates a reviewable changed file. */
export function file(
	path = 'packages/auth/session.ts',
	overrides: Partial<ChangedFile> = {}
): ChangedFile {
	return {
		path,
		status: 'modified',
		additions: 1,
		deletions: 1,
		binary: false,
		sizeBytes: 100,
		...overrides,
	}
}

/** Creates ordinary pull request metadata; no external repository is involved. */
export function pr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
	return {
		author: 'author-a',
		target: 'main',
		labels: [],
		draft: false,
		fork: false,
		trigger: 'auto',
		...overrides,
	}
}

/** Creates one valid model-reported finding with independently allocated evidence. */
export function rawFinding(
	overrides: Partial<ReportedFinding> = {}
): ReportedFinding {
	return {
		path: 'src/billing/charge.ts',
		line: 2,
		severity: 'medium',
		title: 'Duplicate charge loses balance',
		trigger: 'The same invoice is retried.',
		impact: 'The balance is charged twice.',
		evidence: [],
		...overrides,
	}
}

/** Recomputes identity after applying path and title overrides. */
export function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		...toFinding(rawFinding(overrides), {
			agent: 'reviewer',
			model: 'model-a',
			kind: 'bug',
		}),
		...overrides,
	}
}

/** Creates the inputs of a pure plan without model or repository adapters. */
export function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
	return {
		config: config(),
		agents: [],
		files: [file()],
		pr: pr(),
		...overrides,
	}
}

/** Successful routing without additional agents. */
export const NORMAL_ROUTER = {
	status: 'ok',
	risk: 'normal',
	added: [],
} as const satisfies RouterReport

/** A planned finder with explicit overrides for agent and model cases. */
export function plannedRun(overrides: Partial<PlannedRun> = {}): PlannedRun {
	return {
		name: 'reviewer',
		title: 'Main reviewer',
		role: 'reviewer',
		kind: 'bug',
		input: 'incremental',
		model: 'model-a',
		effort: 'high',
		files: ['src/billing/charge.ts'],
		selectedBy: 'default',
		...overrides,
	}
}

/** Separated functions make Git emit independent hunk contexts. */
export function functionSource(value: number, count = 2): string {
	return `${Array.from({ length: count }, (_, index) => [`export function charge${index}() {`, ...Array.from({ length: 10 }, () => '  // fixture context'), `  return ${value}`, '}'].join('\n')).join('\n\n')}\n`
}

/** A unified diff with complete headers and one replacement hunk. */
export function unifiedDiff(
	path: string,
	lines = 1,
	content = 'after'
): string {
	return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${lines} @@\n-before\n${`+${content}\n`.repeat(lines)}`
}

/** Git-quoted paths across modified, deleted and rename-only diff headers. */
export const QUOTED_FILE_DIFFS = [
	{ quoted: String.raw`src/a\"b.ts`, path: 'src/a"b.ts' },
	{ quoted: String.raw`src/a\\b.ts`, path: 'src/a\\b.ts' },
	{ quoted: String.raw`src/\303\251.ts`, path: 'src/é.ts' },
	{ quoted: String.raw`src/a\tb.ts`, path: 'src/a\tb.ts' },
].flatMap(({ quoted, path }) =>
	(['modified', 'deleted', 'renamed'] as const).map(header => ({
		header,
		path,
		diff: [
			`diff --git "a/${quoted}" "b/${quoted}"`,
			...(header === 'renamed'
				? [
						'similarity index 100%',
						'rename from old.ts',
						`rename to "${quoted}"`,
					]
				: header === 'deleted'
					? [
							'deleted file mode 100644',
							`--- "a/${quoted}"`,
							'+++ /dev/null',
							'@@ -1 +0,0 @@',
							'-before',
						]
					: [
							`--- "a/${quoted}"`,
							`+++ "b/${quoted}"`,
							'@@ -1 +1 @@',
							'-before',
							'+after',
						]),
			'',
		].join('\n'),
	}))
)
