import { countSchema, severitySchema } from '@mng-review/domain'
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
	 * Bugs of the last finished run on `head` that got no thread (in the summary, or unposted). The
	 * status sweep counts them, since no thread holds them.
	 */
	unthreadedBugs: Schema.optionalKey(countSchema),
})
export type SummaryMarker = typeof summaryMarkerSchema.Type

export const REPLY_ACTIONS = ['resolved'] as const

/** The hidden marker of the bot's reply in one of its threads: what it did and at which head. */
export const replyMarkerSchema = Schema.Struct({
	v: Schema.Literal(MARKER_VERSION),
	action: Schema.Literals(REPLY_ACTIONS),
	commit: Schema.String,
})
export type ReplyMarker = typeof replyMarkerSchema.Type
