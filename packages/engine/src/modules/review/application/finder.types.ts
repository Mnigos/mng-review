import type { Finding, ModelSetting } from '@mng-review/domain'
import type { Rules } from '../../../platform/config/rules.service'
import type { TokenPool } from '../domain/loop-budget.helper'
import type { AgentRunReport } from '../domain/review-report.types'
import type { RepoToolName } from './repo.toolkit'
import type { RepoScope } from './services/repo-tools.service'

/** What every finder of one run shares. */
export interface FinderContext {
	readonly scope: RepoScope
	readonly rules: Pick<Rules, 'agents' | 'context'>
	/** Deep depth: the main reviewer runs one sub-agent per unit of the change. */
	readonly fanOut: boolean
	/** Models to switch to, in order, when the run's model is dropped; `undefined` keeps the model. */
	readonly fallback: readonly ModelSetting[] | undefined
	readonly tokens: FinderTokens
	/** At deep depth, review only the units that touch one of these paths; `undefined` reviews all. */
	readonly unitPaths?: readonly string[]
}

/** Tokens one planned finder may spend. */
export interface FinderTokens {
	/** This run's share of the finders' tokens, split evenly over its units. */
	readonly allowance: number
	/** Every finder answers once the whole run has spent this many tokens. */
	readonly runTokens: number
	/** Shares finders left unspent, which the main reviewer's conversations may claim. */
	readonly pool?: TokenPool
}

/** A finder's report and its findings, `max_findings` applied. */
export interface FinderResult {
	readonly report: AgentRunReport
	readonly findings: readonly Finding[]
}

/** One agent conversation: the main reviewer, one unit of it, or a declared agent. */
export interface FinderJob {
	readonly system: string
	readonly user: string
	readonly tools: readonly RepoToolName[]
	/** The unit's label when a deep review splits the change. */
	readonly unit?: string
	/** Tokens this conversation may spend. */
	readonly tokens: number
	/**
	 * Changed files the agent must read before it answers (the main reviewer's method): those the
	 * first message does not show whole.
	 */
	readonly coverage?: readonly string[]
	/** The head lines each file of the job's diff changes (`getChangedLines`). */
	readonly changed?: ReadonlyMap<string, readonly number[]>
}
