/**
 * What the model may read in an author's reply: the problem is `fixed`, the code is `intentional`,
 * or neither can be told.
 */
export const REPLY_CLAIMS = ['fixed', 'intentional', 'unclear'] as const
/** What the bot does with a reply; see `toReplyDecision`. */
export const REPLY_ACTIONS = [
	'resolved',
	'accepted',
	'still-found',
	'disputed',
	'needs-owner',
	'seen',
] as const
/** Characters of the model's reason a memory candidate keeps. */
export const MEMORY_REASON_MAX_CHARS = 160
/** Characters of any reason a reply decision or the model's answer keeps. */
export const REPLY_REASON_MAX_CHARS = 300
