import type { RISK_LEVELS } from './routing.constants'

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
}

export type Risk = (typeof RISK_LEVELS)[number]
export type Depth = 'quick' | 'balanced' | 'deep'

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

/** What the router model did for a run. */
export interface RouterReport {
	readonly status: 'ok' | 'failed' | 'skipped'
	readonly detail?: string
	readonly risk?: Risk
	readonly added: readonly RouterAddition[]
}
