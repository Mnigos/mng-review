import type {
	RiskConfig,
	RiskDescription,
	StatusLevel,
	UnratedReason,
} from '@mng-review/domain'
import type { ReviewReport, Rules } from '@mng-review/engine'
import type { MarkerRead, RatingBlock, WritingDecision } from './risk.types'

/** The pull request and commits a rating is about, and the rules from the base commit. */
export interface RiskTarget {
	readonly pullNumber: number
	readonly head: string
	/** The bound base commit; the merge base is read from git, never from the outcome file. */
	readonly baseSha: string
	/** The repository's default branch; the grant checks the pull request is still into it. */
	readonly defaultBranch: string
	readonly rules: Rules
	/**
	 * Node ids of the bot threads a thread run answered without closing them; the thread raise
	 * counts them as open even when GitHub shows them resolved.
	 */
	readonly answered?: readonly string[]
}

/** A full run: the target and the review whose rating, router and kept bugs it reads. */
export interface FullRiskInput extends RiskTarget {
	readonly report: Pick<ReviewReport, 'rating' | 'bugs' | 'planReport'>
}

/** A run past step 1: what it wrote there and what it will publish. */
export interface RiskRun {
	readonly pullNumber: number
	readonly head: string
	/** The bound base commit the merge base was read from; the grant checks it again. */
	readonly baseSha: string
	readonly defaultBranch: string
	readonly labels: RiskConfig['labels']
	readonly held: StatusLevel
	/** Step 1's `error`; the grant carries the same number, base, rules and nonce. */
	readonly description: RiskDescription
	readonly decision: WritingDecision
	/** The risk comment after step 1 created or rewrote it. */
	readonly marker: MarkerRead
	readonly tree: string | undefined
	/** What the review body shows; unset for a thread run, which posts no review. */
	readonly block?: RatingBlock
}

/** What a rating left on the head. */
export interface RiskResult {
	/** `none` when the run wrote no status. */
	readonly state: 'success' | 'failure' | 'error' | 'none'
	readonly level: StatusLevel
	readonly reason?: UnratedReason
	readonly detail?: string
	/** A label write failed; the label is display only. */
	readonly labelFailed?: boolean
	/**
	 * The grant could not be read back and the `error` over it was refused, so it may still stand;
	 * the job fails so the cleanup step writes that `error` again.
	 */
	readonly grantStands?: boolean
}

/** A run that started, or the reason a thread run writes nothing. */
export type RiskStart =
	| { readonly status: 'started'; readonly run: RiskRun }
	| { readonly status: 'none' }
