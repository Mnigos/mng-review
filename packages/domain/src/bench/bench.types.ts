import type { Finding } from '../findings/finding.types'
import type { ExpectedFinding } from './bench-file.schema'

/** A bug finding a review kept, as far as the benchmark compares it. */
export type BenchFinding = Pick<Finding, 'path' | 'line' | 'title' | 'severity'>

/** An expected entry and the finding that matched it. */
export interface BenchMatch {
	readonly expected: ExpectedFinding
	readonly finding: BenchFinding
}

/** How the bug findings of one case compare with its expected entries. */
export interface CaseScore {
	/** `real` entries a finding matched. */
	readonly found: readonly BenchMatch[]
	/** `real` entries no finding matched. */
	readonly missed: readonly ExpectedFinding[]
	/** `intentional` or `false` entries a finding matched. */
	readonly noise: readonly BenchMatch[]
	/** Findings that matched no entry. */
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
	readonly missed: number
	readonly noise: number
	readonly unmatched: number
	readonly nits: number
	/** `found` over all `real` entries; `null` without any. */
	readonly recall: number | null
	/** Unmatched findings per case; `null` without cases. */
	readonly unmatchedPerCase: number | null
}
