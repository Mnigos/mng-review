import type {
	BenchTotals,
	CaseScore,
	Depth,
	RejectedFinding,
	Risk,
} from '@mng-review/domain'
import type {
	TokensByModel,
	TokensBySource,
} from '../../../platform/llm/token-ledger.service'
import type { AgentRunReport } from '../../review/domain/review-report.types'

/** A bug the validator rejected in a case, with its reason. */
export type BenchRejected = Pick<
	RejectedFinding,
	'path' | 'line' | 'title' | 'severity' | 'reason' | 'validatedBy'
>

/** How one finder of a case worked: its tool calls, units and continuations. */
export type BenchAgent = Pick<
	AgentRunReport,
	| 'name'
	| 'model'
	| 'status'
	| 'toolCalls'
	| 'findings'
	| 'units'
	| 'continued'
	| 'unfinished'
>

/** How one case of a benchmark went. */
export interface CaseReport {
	readonly id: string
	readonly base: string
	readonly head: string
	readonly score: CaseScore
	/** The depth the plan chose, and why. */
	readonly depth: { readonly level: Depth; readonly source: string }
	readonly risk: Risk
	/** Bugs the validator refuted, with its reason. */
	readonly rejected: readonly BenchRejected[]
	/** Nits the review kept; they never match expected entries. */
	readonly nits: number
	readonly tokens: TokensByModel
	/** Finder and validator tokens by source. */
	readonly tokenSources: TokensBySource
	/** Each finder's tool calls, units and continuations. */
	readonly agents: readonly BenchAgent[]
	readonly wallMillis: number
	/** Why the gate skipped the whole run, when it did. */
	readonly skipped?: string
	/** Set when a finder failed at the endpoint, or no reviewer model was left. */
	readonly endpointError?: string
	/** What the token budget stopped before it answered; the case's findings are partial. */
	readonly incomplete?: readonly string[]
}

/** What `mng-review bench` reports: every case, the totals and tokens per model over all cases. */
export interface BenchReport {
	readonly file: string
	/** `working tree` or the rules ref. */
	readonly rulesSource: string
	readonly lineWindow: number
	readonly cases: readonly CaseReport[]
	readonly totals: BenchTotals
	readonly tokens: TokensByModel
	readonly wallMillis: number
}
