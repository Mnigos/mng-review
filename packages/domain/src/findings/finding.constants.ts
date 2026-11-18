/** Lines apart within which two findings in one file can share a root cause. */
export const NEAR_LINES = 3
/** Title word overlap (Jaccard) at which two nearby findings count as one problem. */
export const SAME_TITLE_OVERLAP = 0.5
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
