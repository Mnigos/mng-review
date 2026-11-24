import { countSchema } from '@mng-review/domain'
import { Schema } from 'effect'
import { findingMarkerSchema } from './publish-marker.schema'

/**
 * One of the bot's threads as a file between two steps of a job holds it. JSON has no
 * `undefined`, so the line, original line, commit, latest comment and resolver are left out when unknown; the reader turns
 * them back into a `BotThread`. The marker is decoded again, so a thread with a broken marker fails.
 */
export const botThreadSchema = Schema.Struct({
	id: Schema.String,
	resolved: Schema.Boolean,
	closedByBot: Schema.Boolean,
	onFile: Schema.Boolean,
	path: Schema.String,
	line: Schema.optionalKey(Schema.Int),
	originalLine: Schema.optionalKey(Schema.Int),
	commit: Schema.optionalKey(Schema.String),
	marker: findingMarkerSchema,
	replies: countSchema,
	latestCommentId: Schema.optionalKey(Schema.Int),
	latestAuthor: Schema.optionalKey(
		Schema.Struct({ type: Schema.String, login: Schema.String })
	),
	latestMarked: Schema.Boolean,
	latestDigest: Schema.optionalKey(Schema.String),
	closedAt: Schema.optionalKey(Schema.String),
	sentToOwner: Schema.Boolean,
	/** Left out when the read's windows did not show the newest app answer. */
	unsettled: Schema.optionalKey(Schema.Boolean),
})
export type BotThreadFile = typeof botThreadSchema.Type
