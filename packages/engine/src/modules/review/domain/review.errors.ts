import { Schema } from 'effect'

/** An agent that gave no valid answer, ran past its wall time or would not stop calling tools. */
export class LoopError extends Schema.TaggedError<LoopError>()('LoopError', {
	reason: Schema.String,
}) {
	override get message() {
		return this.reason
	}
}

/**
 * A call to a model the run dropped after a 429, 503 or unknown-model answer. Not an endpoint
 * failure of its own: the run goes on with the remaining models.
 */
export class ModelDroppedError extends Schema.TaggedError<ModelDroppedError>()(
	'ModelDroppedError',
	{ model: Schema.String, reason: Schema.String }
) {
	override get message() {
		return `model ${this.model} was dropped for this run: ${this.reason}`
	}
}

/** No model call starts once the run has spent `limits.tokens_per_run`. */
export class TokenBudgetError extends Schema.TaggedError<TokenBudgetError>()(
	'TokenBudgetError',
	{ spent: Schema.Number, limit: Schema.Number }
) {
	override get message() {
		return `token budget spent: ${this.spent} of limits.tokens_per_run ${this.limit}`
	}
}

/** A tool call the repository cannot answer; the model gets the reason as `error: …` text. */
export class ToolError extends Schema.TaggedError<ToolError>()('ToolError', {
	reason: Schema.String,
}) {
	override get message() {
		return this.reason
	}
}
