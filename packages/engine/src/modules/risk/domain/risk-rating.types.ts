import type {
	FloorHit,
	RiskLevel,
	StatusLevel,
	UnratedReason,
} from '@mng-review/domain'

/** What every rating names: what it was made on and the floors the complete change hits. */
export interface RatingBinding {
	/** The head commit the rating was made on. */
	readonly head: string
	/** The merge base the rating diffed from. */
	readonly base: string
	/** The `rules=` digest over the rubric, the merged `risk` keys and the built-in floor version. */
	readonly rules: string
	/** Floors from `git diff --no-renames --raw --numstat -z` at the base and head. */
	readonly floors: readonly FloorHit[]
	/** True when any floor applied, the built-in one included. */
	readonly floor: boolean
}

/**
 * A rating the rater gave with full coverage. `level` is the highest of the rater's level, the
 * floors, Medium for a router `risky` and High for a confirmed High or Critical bug of this run;
 * publish raises it further with the held level, the marker and its own read of the threads.
 */
export interface RatedRisk extends RatingBinding {
	readonly status: 'rated'
	readonly level: RiskLevel
	/** The rater's own level. */
	readonly model: RiskLevel
	/** The one to three sentences that drive the level, cut to their limits. */
	readonly reasons: readonly string[]
	/** `path:start-end` ranges of the diff that drive the level. */
	readonly refs: readonly string[]
	readonly up?: string
	readonly down?: string
	/** The model that rated. */
	readonly rater: string
}

/** A run that rates but could not: publish writes `error` and never a level from it. */
export interface UnratedRisk extends RatingBinding {
	readonly status: 'unrated'
	readonly reason: UnratedReason
	readonly detail: string
}

export type RiskRating = RatedRisk | UnratedRisk

/** What the rater reads besides the change: the rules, the findings and the earlier rating. */
export interface RaterInput {
	readonly rubric: string
	readonly floors: readonly FloorHit[]
	/** The highest level an earlier rating of this pull request published; `none` when unknown. */
	readonly previous: StatusLevel
}
