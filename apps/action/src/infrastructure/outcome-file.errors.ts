import { Schema } from 'effect'

/** The outcome file is too large, not JSON, or does not match its schema. */
export class OutcomeFileError extends Schema.TaggedError<OutcomeFileError>()(
	'OutcomeFileError',
	{ message: Schema.String }
) {}
