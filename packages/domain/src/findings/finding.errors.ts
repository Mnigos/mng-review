import { Schema } from 'effect'

/** A findings answer without a `findings` list. */
export class FindingsAnswerError extends Schema.TaggedError<FindingsAnswerError>()(
	'FindingsAnswerError',
	{ message: Schema.String }
) {}
