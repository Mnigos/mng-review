import { countSchema, REPLY_ACTIONS, severitySchema } from '@mng-review/domain'
import { Schema } from 'effect'
import { MARKER_VERSION } from './publish.constants'

export const THREAD_KINDS = ['bug', 'unverified', 'nit'] as const

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
})
export type ReplyMarker = typeof replyMarkerSchema.Type
