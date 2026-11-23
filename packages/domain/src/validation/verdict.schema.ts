import { Schema, SchemaTransformation } from 'effect'
import { severitySchema } from '../config/review-config.schema'

/**
 * `unverified`: the premises in the repository hold, but the bug rests on a dependency's documented
 * behaviour the repository cannot show.
 */
export const VERDICTS = ['confirm', 'reject', 'unverified'] as const
/** `path:line` or `path:start-end`, optionally followed by a note; the path may hold spaces, not colons. */
const EVIDENCE_PATTERN = /^[^\s:](?:[^:]*[^\s:])?:\d+(?:-\d+)?(?:\s|$)/u

/** Most characters a validator's reason keeps (`toValidation` cuts it); people read it, so two short sentences. */
export const MAX_VERDICT_REASON_CHARS = 800
/** Most characters an unverified finding's premise keeps: one sentence naming the package. */
export const MAX_PREMISE_CHARS = 300

/** One `path:line` evidence entry, trimmed. */
export const evidenceSchema = Schema.Trim.check(
	Schema.isPattern(EVIDENCE_PATTERN, {
		message: 'evidence must start with path:line',
	})
)

/**
 * A fix as one edit of the finding's line: that line's text at head and the code that replaces it,
 * whitespace kept. The engine checks it against the head before a comment may suggest it.
 */
const lineEditSchema = Schema.Struct({
	line: Schema.String,
	replacement: Schema.String,
})

/**
 * A validator's answer: confirm, reject or unverified, a re-rated severity, a reason and `path:line`
 * evidence; `unverified` also names the premise it could not check. A rejection without evidence
 * and a lower severity without `lowered_because` decode; `toValidation` decides what they keep.
 */
export const verdictSchema = Schema.Struct({
	verdict: Schema.Literals(VERDICTS),
	severity: Schema.String.pipe(
		Schema.decode(SchemaTransformation.toLowerCase()),
		Schema.decodeTo(severitySchema)
	),
	reason: Schema.Trim.check(Schema.isNonEmpty()),
	evidence: Schema.Array(evidenceSchema),
	/** The dependency behaviour an `unverified` finding rests on. */
	premise: Schema.optionalKey(Schema.NullOr(Schema.Trim)),
	/** Which part of the reported severity's criterion fails; required to lower the severity. */
	lowered_because: Schema.optionalKey(Schema.NullOr(Schema.Trim)),
	/** Numbers of the listed nearby findings that describe the same defect as this one. */
	same_root_cause: Schema.optionalKey(
		Schema.NullOr(
			Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))
		)
	),
	/** A confirmed fix that is one edit of the finding's line; `toConfirmedEdit` checks it. */
	edit: Schema.optionalKey(Schema.NullOr(lineEditSchema)),
}).check(
	Schema.makeFilter(
		answer =>
			answer.verdict === 'reject' ||
			answer.evidence.length > 0 ||
			`${answer.verdict} needs at least one path:line evidence entry`
	),
	Schema.makeFilter(
		answer =>
			answer.verdict !== 'unverified' ||
			Boolean(answer.premise) ||
			'unverified needs the premise the repository cannot show'
	)
)
export type Verdict = typeof verdictSchema.Type
