import type { RiskLevel, StatusLevel } from './risk-description.schema'
import type { RISK_RUN_KINDS, UNRATED_REASONS } from './risk.constants'

/** Added and deleted lines of one text file. */
export interface LineTotals {
	readonly added: number
	readonly deleted: number
}

/** A file's counts: lines, `binary` when git counts none, `unknown` when they did not parse. */
export type FloorCount = LineTotals | 'binary' | 'unknown'

/** One path the floor diff names. A rename shows as its old and its new path, each on its own. */
export interface FloorDiffFile {
	readonly path: string
	/** The `--raw` status letter, such as `M`, `A`, `D` or `T`. */
	readonly status: string
	/**
	 * Git modes before and after; `000000` when the side has no file, empty when no raw record named
	 * it.
	 */
	readonly oldMode: string
	readonly newMode: string
	readonly count: FloorCount
}

/** `git diff --no-renames --raw --numstat -z` read whole. */
export interface FloorDiff {
	readonly files: readonly FloorDiffFile[]
	/**
	 * False when a record did not parse or the two parts disagree, so the change is not fully known.
	 */
	readonly intact: boolean
}

/** What the floors read besides the diff. */
export interface FloorSettings {
	readonly floors: readonly ConfiguredFloor[]
	/** `risk.assets`: binaries the rater may leave unread. */
	readonly assets: readonly string[]
	/** Every file the rules resolve to: the rubric and anything it imports. */
	readonly rulesPaths: readonly string[]
}

/** A configured floor as `risk.floors[]` holds it after decoding. */
export interface ConfiguredFloor {
	readonly name: string
	readonly paths: readonly string[]
	readonly exclude: readonly string[]
	readonly level: RiskLevel
}

/** One floor that applied: its level, the paths that hit it and their summed line counts. */
export interface FloorHit extends LineTotals {
	readonly name: string
	readonly level: RiskLevel
	readonly builtIn: boolean
	readonly paths: readonly string[]
}

/** The floors a change hits and the binaries it changes outside `risk.assets`. */
export interface FloorReport {
	readonly hits: readonly FloorHit[]
	/** Binary paths outside `risk.assets`; any leaves the pull request unrated. */
	readonly opaque: readonly string[]
}

/** Everything that sets a rating's level; the result is never lower than any of them. */
export interface RiskSources {
	/** The rater's level, or the stored level of a rated entry with the same tree and base. */
	readonly model: RiskLevel
	readonly floors: readonly Pick<FloorHit, 'level'>[]
	/** The router rated the change `risky`. */
	readonly routerRisky: boolean
	/** Severities of the open or carried confirmed bugs publish's own thread read found. */
	readonly confirmedBugs: readonly string[]
	/** The highest level the trusted marker keeps. */
	readonly markerHighest: StatusLevel
	/** The highest level on any app status for this pull request's number. */
	readonly held: StatusLevel
}

/** A commit status as the API returns it, already filtered to the app's `MNG Review risk`. */
export interface RiskStatus {
	readonly state: string
	readonly description: string
}

/** What a comment's author looks like to the acted-on rule. */
export interface CommentAuthor {
	readonly login: string
	/** `User`, `Bot` or `Organization`; only a `User` counts. */
	readonly type: string
	/** Set when an app posted the comment on a person's behalf. */
	readonly viaApp: boolean
}

/**
 * A collaborator's role as the API returns it: a built-in or custom role and its base permission.
 */
export interface RepositoryRole {
	readonly role_name: string
	readonly permission: string
}

/** A command as the engine's grammar reads it. */
export interface FixtureCommand {
	readonly depth?: 'deep' | 'quick'
	readonly agent?: string
}

/** Where a comment sits; only a conversation comment can hold a command. */
export type CommentPlace =
	| 'conversation'
	| 'review-thread'
	| 'review-body'
	| 'pr-body'

/** One command grammar case both the engine and the sweep run. */
export interface CommandFixture {
	readonly name: string
	readonly place: CommentPlace
	readonly body: string
	/** The command the reader takes; absent when the comment holds none. */
	readonly command?: FixtureCommand
}

/** One digest case: a body and the 16 hex characters every reader computes for it. */
export interface DigestFixture {
	readonly name: string
	readonly body: string
	readonly digest: string
}

/** One acted-on case: an author, the role read for them and whether their comments count. */
export interface AuthorFixture {
	readonly name: string
	readonly author: CommentAuthor
	readonly role: RepositoryRole
	readonly actedOn: boolean
}

/** A thread of the app as the converse reads it; every flag is false when unset. */
export interface ThreadState {
	readonly kind: 'bug' | 'unverified' | 'nit'
	/** Resolved on GitHub, or closed by the bot's own `resolved` or `accepted` reply. */
	readonly resolved?: boolean
	readonly closedByBot?: boolean
	/** In the summary marker's list of threads that wait for the owner. */
	readonly waiting?: boolean
	/** The bot answered `needs-owner` in the thread. */
	readonly sentToOwner?: boolean
	/** The thread holds the reply a dispatched converse was sent for. */
	readonly held?: boolean
}

/** One thread-state case: whether the converse answers a reply in it. */
export interface ThreadFixture {
	readonly name: string
	readonly state: ThreadState
	readonly answered: boolean
}

/** A run that touches the rating; `RISK_RUN_KINDS` says what each is. */
export type RiskRunKind = (typeof RISK_RUN_KINDS)[number]

/**
 * How a run ended. `rated` finished with coverage, threads and marker read; `not-rated` is any
 * reason in `UNRATED_REASONS`; `step-one-failed` is a failed held read or status create or
 * read-back before or in step 1; `raised` is a thread run that found an open confirmed High or
 * Critical bug. The sweep's outcomes name what it found on the head: `no-status` with the
 * pre-model checks passing, `no-status-blocked` when they fail, `reply-unanswered` and
 * `review-unrated` when its holds allow a dispatch. `refused` is a refused command for the denial
 * job; `any` stands for every outcome of a kind.
 */
export type RiskRunOutcome =
	| 'rated'
	| 'not-rated'
	| 'step-one-failed'
	| 'raised'
	| 'no-status'
	| 'no-status-blocked'
	| 'reply-unanswered'
	| 'review-unrated'
	| 'refused'
	| 'over-cap'
	| 'any'

/** Why a full or thread run publishes `error` instead of a level. */
export type UnratedReason = (typeof UNRATED_REASONS)[number]

/**
 * What a run does to the head: the status it writes (`combined` and `raised` carry the combined
 * level, `error` the step-1 maximum, `none` writes nothing), the label, whether the job fails so
 * the sweep's run hold sees it, what it dispatches and which answer the denial job posts.
 */
export interface RunEffect {
	readonly status: 'combined' | 'raised' | 'error' | 'none'
	/** `unlabel` is the label job's removal on push; `removed` is the run's own cleanup. */
	readonly label: 'combined' | 'raised' | 'removed' | 'kept' | 'unlabel'
	readonly failsJob: boolean
	/** `event` is the bridge's dispatch of the review workflow for the review event. */
	readonly dispatch?: 'review' | 'converse' | 'event'
	readonly answer?: 'cap' | 'deny'
}
