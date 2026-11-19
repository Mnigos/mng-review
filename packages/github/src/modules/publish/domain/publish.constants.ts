/** The login GraphQL gives the job token's identity, `github-actions[bot]` in REST. */
export const BOT_LOGIN = 'github-actions'
/** The opening of every hidden marker the bot writes; a marker sits alone at the end of a body. */
export const MARKER_PREFIX = 'mng-review:'
export const MARKER_VERSION = 1
/** Characters of a commit SHA shown in comments. */
export const SHORT_SHA_LENGTH = 8
/** Lines either side of a finding where a change since a resolved thread counts as touching its place. */
export const THREAD_PLACE_LINES = 6
/** Open threads the bot checks again in one run, most recently changed first; the rest wait for the next run. */
export const MAX_RECHECKS = 8
