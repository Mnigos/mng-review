import { Schema } from 'effect'

/** A git command that could not run or exited with an error; carries git's own diagnostics. */
export class GitError extends Schema.TaggedError<GitError>()('GitError', {
	args: Schema.Array(Schema.String),
	/** `-1` when git could not be started. */
	exitCode: Schema.Number,
	stderr: Schema.String,
}) {
	override get message() {
		const detail = this.stderr.trim()
		return `git ${this.args.join(' ')} failed (${this.exitCode})${detail ? `: ${detail}` : ''}`
	}
}
