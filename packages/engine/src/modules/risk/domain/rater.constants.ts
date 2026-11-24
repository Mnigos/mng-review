/** Reasons a rating keeps; the rater gives at least one. */
export const MAX_RISK_REASONS = 3
/** Longest reason a rating keeps; a longer one is cut, never dropped. */
export const MAX_RISK_REASON_CHARS = 300
/** Diff ranges a rating keeps. */
export const MAX_RISK_REFS = 10
/** Longest diff range a rating keeps. */
export const MAX_RISK_REF_CHARS = 200
/** Longest `up` or `down` sentence a rating keeps. */
export const MAX_RISK_DIRECTION_CHARS = 300
/** Longest note on why a change is unrated; the paths it names are cut, never the rating. */
export const MAX_RISK_DETAIL_CHARS = 1000
/**
 * Tokens the rater's conversation plans to spend. It must receive every changed hunk, so it gets
 * more than a validation: the first message carries up to `MAX_FULL_DIFF_CHARS` of the diff.
 */
export const RATER_TOKENS = 400_000
/** The rater's line in the run's tokens by source. */
export const RATER_SOURCE = 'rater'
export const NO_RATER_MODEL = 'no rater model left'
