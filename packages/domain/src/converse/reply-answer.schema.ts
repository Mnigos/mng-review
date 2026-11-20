import { Effect, Schema, SchemaGetter, SchemaTransformation } from 'effect'
import { evidenceSchema } from '../validation/verdict.schema'
import { REPLY_CLAIMS } from './reply.constants'

/** An optional text a model may also send as `null`. */
const optionalTextSchema = Schema.optionalKey(Schema.NullOr(Schema.Trim))

/**
 * The model's answer about one reply: the claim it read, whether an `intentional` reason holds,
 * its one-sentence restatement, the failed premise and `path:line` evidence. The claim is trimmed
 * and read without case; a missing or `null` `holds` decodes as not holding.
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
