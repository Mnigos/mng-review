import {
	answerEntrySchema,
	countSchema,
	REPLY_ACTIONS,
	riskLevelSchema,
	severitySchema,
} from '@mng-review/domain'
import { Schema } from 'effect'
import { MARKER_VERSION, MAX_ANSWER_ENTRIES } from './publish.constants'

export const THREAD_KINDS = ['bug', 'unverified', 'nit'] as const

/** The entries an app answer carries; each names comments it handled at the version it read. */
const answerListSchema = Schema.Array(answerEntrySchema).check(
	Schema.isMaxLength(MAX_ANSWER_ENTRIES)
)

/**
 * The hidden marker at the end of each finding comment: who reported what, so a later run finds
 * its own threads and never posts a finding twice.
 */
export const findingMarkerSchema = Schema.Struct({
	v: Schema.Literal(MARKER_VERSION),
	id: Schema.String,
	kind: Schema.Literals(THREAD_KINDS),
	agent: Schema.String,
	severity: severitySchema,
	fingerprint: Schema.String,
	title: Schema.String,
	/** The finding's line at the commit it was posted on, also for a comment on the file. */
	line: Schema.Int,
	/** Trigger and impact as the finder wrote them, so a later run can check the finding again. */
	trigger: Schema.optionalKey(Schema.String),
	impact: Schema.optionalKey(Schema.String),
	/** The engine commit that posted it; `null` outside the workflow. */
	engine: Schema.NullOr(Schema.String),
	/**
	 * Set when validation confirmed the bug; only such a thread raises the risk rating, as only a
	 * confirmed bug of the run does. Unset for an unvalidated bug.
	 */
	confirmed: Schema.optionalKey(Schema.Literal(true)),
})
export type FindingMarker = typeof findingMarkerSchema.Type
export type ThreadKind = FindingMarker['kind']

/**
 * The hidden marker of the sticky summary: how many runs reviewed the pull request, and the last
 * head a run reviewed completely, which incremental input starts from. Unset until a run finishes.
 */
export const summaryMarkerSchema = Schema.Struct({
	v: Schema.Literal(MARKER_VERSION),
	runs: countSchema,
	head: Schema.optionalKey(Schema.String),
	/** Whether the last run finished; the status sweep reads it, never the status text. */
	finished: Schema.optionalKey(Schema.Boolean),
	/**
	 * The last full run had a run or unit that failed or never reported (`hasFailedRuns`), so a
	 * reply-only run on its head clears no change request. Unset when none failed.
	 */
	failed: Schema.optionalKey(Schema.Boolean),
	/** Runs a command started, counted before the endpoint is used; `commands.max_runs` caps them. */
	manualRuns: Schema.optionalKey(countSchema),
	/**
	 * Bugs on `head` that got no thread (in the summary, or unposted): the last full review's, plus
	 * those of every run since on the same head that did not replace it. Such a run and the status
	 * sweep count them, since no thread holds them; the next full review replaces the count.
	 */
	unthreadedBugs: Schema.optionalKey(countSchema),
	/**
	 * Node ids of threads whose last answer was `needs-owner` and that no owner has cleared. It lives
	 * here because a later comment in the thread would hide the bot's answer from a read of the
	 * latest comment.
	 */
	needsOwner: Schema.optionalKey(Schema.Array(Schema.String)),
	/**
	 * The level a rating block in this review published. A trusted app review with it is app
	 * history: the pull request had a real rating, so a lost risk comment never resets it.
	 */
	risk: Schema.optionalKey(riskLevelSchema),
	/** The commands this review answered: a `review` or `run <agent>` answer, or a rating review. */
	answers: Schema.optionalKey(answerListSchema),
})
export type SummaryMarker = typeof summaryMarkerSchema.Type

/**
 * The hidden marker of the bot's reply in one of its threads: what it did, at which head, and the
 * `databaseId` of the author's comment it answers, unset for a re-check's reply.
 */
export const replyMarkerSchema = Schema.Struct({
	v: Schema.Literal(MARKER_VERSION),
	action: Schema.Literals(REPLY_ACTIONS),
	commit: Schema.String,
	reply: Schema.optionalKey(Schema.Int),
	/** Every acted-on reply in the thread this answer names, at the version its read saw. */
	answers: Schema.optionalKey(answerListSchema),
	/**
	 * Set while the app has not reopened the thread after this answer: GitHub gives no resolution
	 * time, so until a later write drops it, a resolution GitHub shows may predate the answer.
	 * While the token app's newest answer in a thread carries it, every reader counts the thread
	 * as open and no resolution clears its wait.
	 */
	unsettled: Schema.optionalKey(Schema.Literal(true)),
})
export type ReplyMarker = typeof replyMarkerSchema.Type

/** The hidden marker of a denial or cap reply: the command it refuses. */
export const answerMarkerSchema = Schema.Struct({
	v: Schema.Literal(MARKER_VERSION),
	answers: answerListSchema,
})
export type AnswerMarker = typeof answerMarkerSchema.Type
