import type { Severity } from '../config/review-config.schema'
import type { Finding, PlacedFinding } from '../findings/finding.types'

/**
 * A fix the validator confirmed as one edit of the finding's line, checked against the file at
 * `commit`: `replacement` takes the place of line `line`, whose exact text there is `original`.
 * Publishing reads that line again and suggests the edit only while it still reads `original`.
 */
export interface ConfirmedEdit {
	readonly commit: string
	readonly line: number
	readonly original: string
	readonly replacement: string
}

/** A validator's answer for one bug finding, with the model that gave it. */
export interface Judgement {
	readonly status: 'confirmed' | 'rejected'
	readonly severity: Severity
	readonly reason: string
	readonly evidence: readonly string[]
	readonly model: string
	/** Why the validator lowered the reported severity: the criterion that fails. */
	readonly loweredBecause?: string
	/** What the engine changed in the answer: an unexplained lower severity, a rejection without repository evidence. */
	readonly note?: string
	/** Set only on a confirmation whose fix passed `toConfirmedEdit`. */
	readonly edit?: ConfirmedEdit
}

/**
 * The finding's premises in the repository hold, but it rests on a dependency's documented
 * behaviour the repository cannot show. Kept below confirmed findings and never blocking.
 */
export interface Unverified extends Omit<Judgement, 'status' | 'edit'> {
	readonly status: 'unverified'
	/** The dependency behaviour the finding rests on. */
	readonly premise: string
}

/** The validator gave no usable answer in two attempts; the finding is kept. */
export interface NoJudgement {
	readonly status: 'unvalidated'
	readonly error: string
	/** The run's token budget was spent before the validator answered. */
	readonly budgetSpent?: boolean
}

export type Validation = Judgement | Unverified | NoJudgement

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
