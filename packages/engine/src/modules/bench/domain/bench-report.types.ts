import type { BenchTotals, CaseScore } from '@mng-review/domain'
import type { TokensByModel } from '../../../platform/llm/token-ledger.service'

/** How one case of a benchmark went. */
export interface CaseReport {
	readonly id: string
	readonly base: string
	readonly head: string
	readonly score: CaseScore
	/** Nits the review kept; they never match expected entries. */
	readonly nits: number
	readonly tokens: TokensByModel
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
