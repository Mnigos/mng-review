import { Effect, Schema, SchemaGetter, SchemaTransformation } from 'effect'
import { evidenceSchema } from '../validation/verdict.schema'
import { toCutLine } from './reply-text.helper'
import { REPLY_CLAIMS, REPLY_REASON_MAX_CHARS } from './reply.constants'

/**
 * An optional sentence a model may also send as `null`, on one line and cut to
 * `REPLY_REASON_MAX_CHARS`, since a reply can show it.
 */
const optionalTextSchema = Schema.optionalKey(
	Schema.NullOr(
		Schema.String.pipe(
			Schema.decodeTo(Schema.String, {
				decode: SchemaGetter.transform(text =>
					toCutLine(text, REPLY_REASON_MAX_CHARS)
				),
				encode: SchemaGetter.transform(text => text),
			})
		)
	)
)

/**
 * The model's answer about one reply: the claim it read, whether an `intentional` reason holds,
 * its one-sentence restatement, the failed premise and `path:line` evidence. The claim is trimmed
 * and read without case; a missing or `null` `holds` decodes as not holding; `reason` and
 * `failed_premise` are cut to `REPLY_REASON_MAX_CHARS`.
 */
export const replyAnswerSchema = Schema.Struct({
	claim: Schema.Trim.pipe(
		Schema.decode(SchemaTransformation.toLowerCase()),
		Schema.decodeTo(Schema.Literals(REPLY_CLAIMS))
	),
	holds: Schema.NullOr(Schema.Boolean).pipe(
		Schema.decodeTo(Schema.Boolean, {
			decode: SchemaGetter.transform(holds => holds === true),
			encode: SchemaGetter.transform(holds => holds),
		}),
		Schema.withDecodingDefault(Effect.succeed(false))
	),
	reason: optionalTextSchema,
	failed_premise: optionalTextSchema,
	evidence: Schema.Array(evidenceSchema).pipe(
		Schema.withDecodingDefault(Effect.succeed([]))
	),
})
export type ReplyAnswer = typeof replyAnswerSchema.Type
