import { Runtime, Schema } from 'effect'

/** Invalid `.mng/` rules at the base commit, or an event the entry cannot read. */
export const INVALID_CONFIG_EXIT_CODE = 2
/** Git could not read the change: the workflow's checkout is incomplete. */
export const FAILED_EXIT_CODE = 1

/**
 * Ends the workflow entry with an exit code. The summary and the log line already say why, so the
 * runtime does not report it again.
 */
export class ActionExit extends Schema.TaggedError<ActionExit>()('ActionExit', {
	code: Schema.Number,
}) {
	override readonly [Runtime.errorReported] = false

	override get [Runtime.errorExitCode]() {
		return this.code
	}
}
