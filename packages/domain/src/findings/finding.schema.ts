import { Effect, Schema, SchemaTransformation } from 'effect'
import { severitySchema } from '../config/review-config.schema'

const trimmedTextSchema = Schema.Trim.check(Schema.isNonEmpty())
/** Models write severities in any case. */
const severityTextSchema = Schema.String.pipe(
	Schema.decode(SchemaTransformation.toLowerCase()),
	Schema.decodeTo(severitySchema)
)
/** A line number at the head; models sometimes send it as a string. */
const lineSchema = Schema.Union([
	Schema.Int,
	Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Int)),
]).check(Schema.isGreaterThanOrEqualTo(0))

/** One finding as a reviewer model reports it. */
export const reportedFindingSchema = Schema.Struct({
	/** Repository-relative; the answer parser normalises it. */
	path: Schema.NonEmptyString,
	line: lineSchema,
	severity: severityTextSchema,
	/** One short sentence naming the problem. */
	title: trimmedTextSchema,
	/** The input or state that makes it happen. */
	trigger: trimmedTextSchema,
	/** What goes wrong for users or data. */
	impact: trimmedTextSchema,
	/** `path:line` notes. */
	evidence: Schema.Array(trimmedTextSchema).pipe(
		Schema.withDecodingDefault(Effect.succeed([]))
	),
	/** A short, self-contained fix. */
	suggestion: Schema.optionalKey(Schema.NullOr(trimmedTextSchema)),
})
export type ReportedFinding = typeof reportedFindingSchema.Type

/** A findings answer: an object with a `findings` list, or the list itself. */
export const findingsAnswerSchema = Schema.Union([
	Schema.Struct({ findings: Schema.Array(Schema.Unknown) }),
	Schema.Array(Schema.Unknown),
])
