/** Lines apart within which two findings in one file can share a root cause. */
export const NEAR_LINES = 6
/** Title word overlap (Jaccard) at which two nearby findings count as one problem. */
export const SAME_TITLE_OVERLAP = 0.5
/**
 * Share of the shorter description's content words (title, trigger and impact) two nearby reports
 * from different finders must share to count as one problem.
 */
export const SAME_DESCRIPTION_OVERLAP = 0.5
/**
 * Share of the shorter one's title and impact words those reports must also share, so a common
 * trigger alone never merges two different failures.
 */
export const SAME_FAILURE_OVERLAP = 0.4
/** Hex characters kept from the fingerprint hash. */
export const FINGERPRINT_LENGTH = 16
/** Title words the fingerprint ignores. */
export const STOP_WORDS = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'by',
	'can',
	'for',
	'from',
	'in',
	'into',
	'is',
	'it',
	'its',
	'of',
	'on',
	'or',
	'that',
	'the',
	'this',
	'to',
	'when',
	'with',
])
