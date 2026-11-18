import type { Severity } from '../config/review-config.schema'
import type { Finding, PlacedFinding } from '../findings/finding.types'

/** A validator's answer for one bug finding, with the model that gave it. */
export interface Judgement {
	readonly status: 'confirmed' | 'rejected'
	readonly severity: Severity
	readonly reason: string
	readonly evidence: readonly string[]
	readonly model: string
}

/** The validator gave no usable answer in two attempts; the finding is kept. */
export interface NoJudgement {
	readonly status: 'unvalidated'
	readonly error: string
}

export type Validation = Judgement | NoJudgement

/** A bug or nit that is reported, with its validation and the severity its finder gave. */
export interface KeptFinding extends PlacedFinding {
	/** Set when the validator re-rated the severity. */
	readonly reportedSeverity?: Severity
	readonly validation?: Validation
}

/** A bug the validator refuted, with its reason and the model that rejected it. */
export interface RejectedFinding extends Finding {
	readonly reason: string
	readonly validatedBy: string
}

/** What a review reports: kept bugs and nits with their placement, and the rejected bugs. */
export interface ReviewOutcome {
	readonly bugs: readonly KeptFinding[]
	readonly nits: readonly KeptFinding[]
	readonly rejected: readonly RejectedFinding[]
}
