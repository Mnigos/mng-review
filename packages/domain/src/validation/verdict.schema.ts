import { Schema, SchemaTransformation } from 'effect'
import { severitySchema } from '../config/review-config.schema'

export const VERDICTS = ['confirm', 'reject'] as const
/** `path:line` or `path:start-end`, optionally followed by a note; the path may hold spaces, not colons. */
const EVIDENCE_PATTERN = /^[^\s:](?:[^:]*[^\s:])?:\d+(?:-\d+)?(?:\s|$)/u

const evidenceSchema = Schema.Trim.check(
	Schema.isPattern(EVIDENCE_PATTERN, {
		message: 'evidence must start with path:line',
	})
)

/** A validator's answer: confirm or reject, a re-rated severity, a reason and `path:line` evidence. */
export const verdictSchema = Schema.Struct({
	verdict: Schema.Literals(VERDICTS),
	severity: Schema.String.pipe(
		Schema.decode(SchemaTransformation.toLowerCase()),
		Schema.decodeTo(severitySchema)
	),
	reason: Schema.Trim.check(Schema.isNonEmpty()),
	evidence: Schema.Array(evidenceSchema),
}).check(
	Schema.makeFilter(
		answer =>
			answer.verdict === 'reject' ||
			answer.evidence.length > 0 ||
			'a confirmation needs at least one path:line evidence entry'
	)
)
export type Verdict = typeof verdictSchema.Type
