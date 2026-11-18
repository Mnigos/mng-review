import { Schema } from 'effect'

/** `init` cannot write `.mng/`: it exists without `--force`, there is nothing to import, or a write failed. */
export class InitError extends Schema.TaggedError<InitError>()('InitError', {
	reason: Schema.String,
}) {
	override get message() {
		return this.reason
	}
}
