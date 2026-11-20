import type {
	DEPTHS,
	MECHANICAL_CONDITIONS,
	RISK_CATEGORIES,
	RISK_LEVELS,
} from './routing.constants'

/** `manual`: started by a person (CLI, command); `auto`: started by an event. */
export type RunTrigger = 'auto' | 'manual'

/** What the engine knows about the pull request, or about the local branch from the CLI. */
export interface PullRequestInfo {
	readonly author?: string
	readonly labels: readonly string[]
	/** Base branch name, such as `main`. */
	readonly target?: string
	readonly title?: string
	readonly body?: string
	readonly draft: boolean
	readonly fork: boolean
	readonly trigger: RunTrigger
	/**
	 * A depth a person asked for with a command; it wins over labels, `review.yml` and the risk, and
	 * as a request rather than a label it never meets `when.labels` or `skip.labels`.
	 */
	readonly depth?: Depth
}

export type Risk = (typeof RISK_LEVELS)[number]
export type Depth = (typeof DEPTHS)[number]

/** The depth of a run and the rule that decided it. */
export interface DepthDecision {
	readonly depth: Depth
	readonly source: string
}

/** An agent the `when` rules selected, with the files it reviews. */
export interface SelectedByRules {
	readonly selected: true
	readonly files: readonly string[]
}

/** An agent the `when` rules did not select. */
export interface NotSelectedByRules {
	readonly selected: false
	readonly reason: string
	/** Only the path rule failed and the agent has a triage line, so the router may add it. */
	readonly routable: boolean
	/** Files the agent reviews if the router adds it. */
	readonly files: readonly string[]
}

export type RuleSelection = SelectedByRules | NotSelectedByRules

/** An agent the router added, with its reason. */
export interface RouterAddition {
	readonly agent: string
	readonly reason: string
}

export type RiskCategory = (typeof RISK_CATEGORIES)[number]

/** One reason the router gives for a risky change: what kind of code, in which changed file, and how. */
export interface RiskSignal {
	readonly category: RiskCategory
	readonly path: string
	readonly reason: string
}

/** What the router model did for a run. */
export interface RouterReport {
	readonly status: 'ok' | 'failed' | 'skipped'
	readonly detail?: string
	/** Derived by `getRouterRisk` from `signals` and the router's trivial flag. */
	readonly risk?: Risk
	/** The risk signals that name a reviewable changed file; any one makes the change `risky`. */
	readonly signals?: readonly RiskSignal[]
	readonly added: readonly RouterAddition[]
}

/** A mechanical-change condition: enough files, mostly small edits, balanced lines, no risky rewrite. */
export type MechanicalCondition = (typeof MECHANICAL_CONDITIONS)[number]

/** A change measured against the mechanical conditions (`getChangeShape`). */
export interface ChangeShape {
	/** Reviewable files. */
	readonly files: number
	/** Share of reviewable files that are small edits. */
	readonly smallShare: number
	/** How far added and removed lines differ, as a share of both. */
	readonly netShare: number
	/** Files under `risk_paths` with an edit large enough to count as a rewrite. */
	readonly riskyRewrites: readonly string[]
	/** The conditions the change fails; empty for a mechanical change. */
	readonly failed: readonly MechanicalCondition[]
}
