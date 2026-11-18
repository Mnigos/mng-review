import { Schema } from 'effect'

/** The router model answered, but not with a usable route. */
export class RouterAnswerError extends Schema.TaggedError<RouterAnswerError>()(
	'RouterAnswerError',
	{ reason: Schema.String }
) {
	override get message() {
		return `router answer ${this.reason}`
	}
}
