import type { RiskLevel } from './risk-description.schema'

/** Rated levels from the lowest; the order ranks them. */
export const RATED_LEVELS = ['low', 'medium', 'high'] as const
/** Levels a status description carries; `none`, below every rated level, is only on `error`. */
export const STATUS_LEVELS = ['none', 'low', 'medium', 'high'] as const
/** Levels a configured floor may set. */
export const FLOOR_LEVELS = ['medium', 'high'] as const
export const DEFAULT_FLOOR_LEVEL = 'medium'
/** Levels a `success` status grants at; every other level or state grants nothing. */
export const GRANT_LEVELS = ['low', 'medium'] as const
/** Severities of a confirmed bug thread that raise the rating to High. */
export const THREAD_RAISE_SEVERITIES = ['high', 'critical'] as const
/** The commit status context the app writes the rating under. */
export const RISK_STATUS_CONTEXT = 'MNG Review risk'
/** `success` at Low or Medium, `failure` at High, `error` when not rated. */
export const RISK_STATUS_STATES = ['success', 'failure', 'error'] as const
export const GRANT_STATE = 'success'
/**
 * The one form of the status description, at most 121 characters. Readers reject anything else,
 * a trailing newline included.
 */
export const RISK_DESCRIPTION_PATTERN =
	/^v1 pr=([1-9][0-9]{0,9}) (low|medium|high|none) floor=(yes|-) base=([0-9a-f]{40}) rules=([0-9a-f]{12}) nonce=([0-9a-f]{16})$/u
export const RISK_DESCRIPTION_VERSION = 'v1'
export const BASE_SHA_PATTERN = /^[0-9a-f]{40}$/u
export const RULES_DIGEST_PATTERN = /^[0-9a-f]{12}$/u
export const NONCE_PATTERN = /^[0-9a-f]{16}$/u
export const RULES_DIGEST_LENGTH = 12
/** Hex characters of the body digest an answer entry carries. */
export const ANSWER_DIGEST_LENGTH = 16
export const ANSWER_DIGEST_PATTERN = /^[0-9a-f]{16}$/u
/** An edit time as GraphQL gives it, to the second in UTC. */
export const EDIT_TIME_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u
/** What an app answer did for the comments it names. */
export const ANSWER_KINDS = [
	'converse',
	'review',
	'run',
	'cap',
	'deny',
] as const
/** The rubric the rater reads, from the base commit. */
export const RISK_RULES_PATH = '.mng/risk.md'
/** Changes with the built-in floor's coverage; part of the rules digest. */
export const BUILT_IN_FLOOR_VERSION = 1
/** Floor names show in the review body: lowercase letters, digits and inner hyphens, at most 40. */
export const FLOOR_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u
/** GitHub's longest label name. */
export const LABEL_MAX_LENGTH = 50
/** Labels the bot never sets or removes, compared without case. */
export const RESERVED_LABELS = ['blocked'] as const
/** `review` commands that rate one head; a later one gets a cap reply. */
export const DEFAULT_REVIEWS_PER_HEAD = 3
/**
 * `risk.model` value that rates on the validator's model: `models.validator`, else the reviewers in
 * order.
 */
export const VALIDATOR_RISK_MODEL = 'validator'

/** Git modes in `--raw` output. */
export const GIT_MODE = {
	NONE: '000000',
	SYMLINK: '120000',
	GITLINK: '160000',
} as const

/**
 * Names of the built-in floor's hits. The `built-in:` prefix cannot match `FLOOR_NAME_PATTERN`, so
 * no configured floor shares a name with one.
 */
export const BUILT_IN_FLOOR = {
	GITHUB: 'built-in:github',
	MNG: 'built-in:mng',
	CODEOWNERS: 'built-in:codeowners',
	GITATTRIBUTES: 'built-in:gitattributes',
	RULES: 'built-in:rules',
	SUBMODULE: 'built-in:submodule',
	SYMLINK: 'built-in:symlink',
	MODE: 'built-in:mode',
	UNKNOWN_COUNT: 'built-in:unknown-count',
	UNPARSED: 'built-in:unparsed',
} as const

/** Directories the built-in floor covers whole, compared without case. */
export const BUILT_IN_FLOOR_DIRS = ['.github/**', '.mng/**'] as const
/** `CODEOWNERS` places outside `.github/`, compared without case. */
export const CODEOWNERS_PATHS = ['codeowners', 'docs/codeowners'] as const
export const GITATTRIBUTES_NAME = '.gitattributes'

/** Label names per level; one at a time sits on a pull request. */
export const DEFAULT_RISK_LABELS = {
	low: 'Low Risk',
	medium: 'Medium Risk',
	high: 'High Risk',
} as const satisfies Record<RiskLevel, string>

/** Binaries the rater may leave unread: images, fonts, audio, video and PDF. */
export const DEFAULT_RISK_ASSETS = [
	'*.png',
	'*.jpg',
	'*.jpeg',
	'*.gif',
	'*.webp',
	'*.avif',
	'*.ico',
	'*.bmp',
	'*.tif',
	'*.tiff',
	'*.heic',
	'*.woff',
	'*.woff2',
	'*.ttf',
	'*.otf',
	'*.eot',
	'*.mp3',
	'*.wav',
	'*.ogg',
	'*.flac',
	'*.m4a',
	'*.aac',
	'*.opus',
	'*.mp4',
	'*.webm',
	'*.mov',
	'*.avi',
	'*.mkv',
	'*.m4v',
	'*.pdf',
] as const

/**
 * Runs that touch the rating. `full` is a push, `review` or dispatched `review` run on a pull
 * request into the default branch, quick depth and an all-skipped change included; `thread` is a
 * `run <agent>`, reply-only, converse or `status-sweep.yml` thread check; `sweep` is the sweep's
 * pass over one open pull request; `unrated` is no app mode, no `app-environment`, an offline
 * endpoint, a gate skip, an invalid `.mng/`, a fork or a base that is not the default.
 */
export const RISK_RUN_KINDS = [
	'full',
	'thread',
	'over-cap',
	'bridge',
	'sweep',
	'denial',
	'unrated',
	'new-push',
] as const

/** Why a full or thread run publishes `error` instead of a level. */
export const UNRATED_REASONS = [
	'run-failed',
	'budget-stopped',
	'coverage-gap',
	'opaque-binary',
	'rater-failed',
	'thread-read-failed',
	'marker-read-failed',
	'marker-edited',
	'history-without-marker',
	'head-moved',
	'nonce-lost',
	'publish-failed',
] as const

/** GitHub's built-in repository roles; any other `role_name` is a custom role. */
export const BUILT_IN_ROLES = [
	'admin',
	'maintain',
	'write',
	'triage',
	'read',
] as const
/** Built-in roles with write access. */
export const WRITE_ROLES = ['admin', 'maintain', 'write'] as const
/** Base permissions a custom role must map to for write access. */
export const WRITE_PERMISSIONS = ['admin', 'write'] as const
/** The author type whose comments can count; bots and organizations never do. */
export const PERSON_TYPE = 'User'
