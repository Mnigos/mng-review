import { Runtime, Schema } from 'effect'
import { CliError } from 'effect/cli'

/** Configuration errors (an unknown key, a missing flag, an unknown ref) exit with 2. */
export const CONFIG_EXIT_CODE = 2

/**
 * Ends the CLI with an exit code. With a `detail`, `Command.run` prints it as the error message;
 * without one, the reason was printed already (the help for a usage error). The runtime does not
 * log it a second time.
 */
export class CliExit extends Schema.TaggedError<CliExit>()('CliExit', {
	code: Schema.Number,
	detail: Schema.optionalKey(Schema.String),
}) {
	override readonly [Runtime.errorReported] = false

	override get [Runtime.errorExitCode]() {
		return this.code
	}

	override get [CliError.userMessage]() {
		return this.detail
	}
}
