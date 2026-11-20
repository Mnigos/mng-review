import { countSchema } from '@mng-review/domain'
import { Schema } from 'effect'
import { MAX_REPLY_CHARS } from './publish.constants'
import { MAX_REPORT_ENTRIES, MAX_REPORT_TEXT } from './review-report.schema'

const textSchema = Schema.String.check(Schema.isMaxLength(MAX_REPORT_TEXT))
const reasonFields = { reason: textSchema } as const

/**
 * An author's reply the prepare step found in one of the bot's threads, for the review step to
 * decide on: the thread, the comment it answers by `databaseId`, and the reply cut to
 * `MAX_REPLY_CHARS`. `digest` is `toBodyDigest` of the whole reply as read, so publishing sees an
 * edit since. `disputes` counts the bot's earlier `disputed` answers in the thread.
 */
export const pendingReplySchema = Schema.Struct({
	threadId: textSchema,
	fingerprint: textSchema,
	commentId: Schema.Int,
	digest: textSchema,
	author: textSchema,
	body: Schema.String.check(Schema.isMaxLength(MAX_REPLY_CHARS)),
	disputes: countSchema,
})
export type PendingReply = typeof pendingReplySchema.Type

/**
 * The engine's `ReplyDecision` as the outcome file carries it. `accepted` names the evidence
 * entries the engine's check passed, which the answer shows.
 */
export const replyDecisionSchema = Schema.Union([
	Schema.Struct({ action: Schema.Literal('resolved'), ...reasonFields }),
	Schema.Struct({
		action: Schema.Literal('accepted'),
		...reasonFields,
		memory: textSchema,
		evidence: Schema.Array(textSchema).check(
			Schema.isMaxLength(MAX_REPORT_ENTRIES)
		),
	}),
	Schema.Struct({ action: Schema.Literal('still-found'), ...reasonFields }),
	Schema.Struct({ action: Schema.Literal('disputed'), ...reasonFields }),
	Schema.Struct({ action: Schema.Literal('needs-owner'), ...reasonFields }),
	Schema.Struct({ action: Schema.Literal('seen') }),
])
export type ThreadReplyDecision = typeof replyDecisionSchema.Type

/**
 * A decision on one reply, bound to its thread, the thread's fingerprint, the comment it answers
 * and that comment's digest; publishing applies it only while its own read still shows that
 * comment, unedited, as the latest. It never holds the reply's text.
 */
export const decidedThreadReplySchema = Schema.Struct({
	threadId: textSchema,
	fingerprint: textSchema,
	commentId: Schema.Int,
	digest: textSchema,
	decision: replyDecisionSchema,
})
export type DecidedThreadReply = typeof decidedThreadReplySchema.Type
