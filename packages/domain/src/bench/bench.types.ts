import type { Finding } from '../findings/finding.types'
import type { Validation } from '../validation/validation.types'
import type { ExpectedFinding } from './bench-file.schema'

/** What the validator said about a kept bug: never `rejected`, which leaves the list. */
export type BenchStatus = Exclude<Validation['status'], 'rejected'>

/** A bug finding a review kept, as far as the benchmark compares and reports it. */
export interface BenchFinding extends Pick<
	Finding,
	'path' | 'line' | 'title' | 'severity' | 'trigger' | 'impact'
> {
	readonly status: BenchStatus
}

/** An expected entry and the finding that matched it, or sits near it (`CaseScore.near`). */
export interface BenchMatch {
	readonly expected: ExpectedFinding
	readonly finding: BenchFinding
}

/** How the bug findings of one case compare with its expected entries. */
export interface CaseScore {
	/** `real` entries a finding matched. */
	readonly found: readonly BenchMatch[]
	/** `real` entries no finding matched or sat near. */
	readonly missed: readonly ExpectedFinding[]
	/**
	 * `real` entries no finding matched, with a finding in a sibling file of the same directory
	 * that describes the same defect. Never counted as found.
	 */
	readonly near: readonly BenchMatch[]
	/** `intentional` or `false` entries a finding matched. */
	readonly noise: readonly BenchMatch[]
	/** Findings that matched no entry and sit near none. */
	readonly unmatched: readonly BenchFinding[]
}

/** What one case adds to the totals. */
export interface CaseCounts {
	readonly score: CaseScore
	readonly nits: number
}

/** Sums over every case of a run. */
export interface BenchTotals {
	readonly cases: number
	readonly found: number
	/** Found entries whose finding the validator confirmed. */
	readonly confirmed: number
	/** Found entries whose finding the validator left unverified. */
	readonly unverified: number
	readonly missed: number
	readonly near: number
	readonly noise: number
	readonly unmatched: number
	readonly nits: number
	/** `found` over all `real` entries, near ones included; `null` without any. */
	readonly recall: number | null
	/** Unmatched findings per case; `null` without cases. */
	readonly unmatchedPerCase: number | null
}
