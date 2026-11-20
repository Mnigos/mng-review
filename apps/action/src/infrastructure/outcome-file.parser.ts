import { formatSchemaIssue } from '@mng-review/domain'
import { Effect, Schema } from 'effect'
import { OutcomeFileError } from './outcome-file.errors'
import {
	MAX_OUTCOME_BYTES,
	type OutcomeFile,
	outcomeFileSchema,
} from './outcome-file.schema'

const decodeOutcome = Schema.decodeUnknownEffect(
	Schema.fromJsonString(outcomeFileSchema)
)

/**
 * Parses the outcome file. A text over `MAX_OUTCOME_BYTES` is refused before `JSON.parse`; invalid
 * JSON or a value the schema refuses fails with the issue. Keys the schema does not name are
 * dropped.
 */
export function parseOutcomeFile(
	text: string
): Effect.Effect<OutcomeFile, OutcomeFileError> {
	const bytes = new TextEncoder().encode(text).length
	if (bytes > MAX_OUTCOME_BYTES)
		return Effect.fail(
			new OutcomeFileError({
				message: `the outcome file has ${bytes} bytes, over the limit of ${MAX_OUTCOME_BYTES}`,
			})
		)
	return decodeOutcome(text).pipe(
		Effect.mapError(
			error =>
				new OutcomeFileError({
					message: `the outcome file is invalid: ${formatSchemaIssue(error.issue)}`,
				})
		)
	)
}
