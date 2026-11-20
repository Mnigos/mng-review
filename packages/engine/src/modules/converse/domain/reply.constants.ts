/** Evidence entries the engine checks per reply; the rest are ignored. */
export const MAX_EVIDENCE_CHECKED = 10
/** Lines before and after the finding's line the classifier gets in its first message. */
export const FILE_WINDOW_LINES = 80
/** Characters of the author's reply the classifier gets, so a huge reply cannot spend the budget. */
export const MAX_REPLY_CHARS = 4000
/** The tree entry mode of a symbolic link, whose text is a path rather than code. */
export const SYMLINK_MODE = '120000'
/** A diff git printed as binary, which shows no added lines. */
export const BINARY_DIFF = /^(?:Binary files |GIT binary patch)/mu
/** The failure of an attempt that finds every validator model dropped. */
export const NO_MODEL_LEFT = 'no validator model left'
/** The classifiers' line in the run's tokens by source. */
export const REPLY_SOURCE = 'reply'
