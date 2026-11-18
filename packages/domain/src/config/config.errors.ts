import { Schema } from 'effect'

/** A problem with a `.mng/` file: invalid YAML, an unknown key or a value its schema rejects. */
export class ConfigError extends Schema.TaggedError<ConfigError>()(
	'ConfigError',
	{
		/** The file, such as `.mng/review.yml` or `.mng/agents/auth.md`. */
		source: Schema.String,
		reason: Schema.String,
	}
) {
	override get message() {
		return `${this.source}: ${this.reason}`
	}
}
