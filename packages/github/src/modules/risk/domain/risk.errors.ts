import { Schema } from 'effect'

/**
 * A read or write the rating needs before or in step 1 failed: the held read (timeline or
 * statuses), the merge base, or the status create or its read-back. The job fails, so the merge
 * sweep's run hold keeps the head unmergeable until a newer app status.
 */
export class RiskStepOneError extends Schema.TaggedError<RiskStepOneError>()(
	'RiskStepOneError',
	{
		stage: Schema.Literals([
			'held-read',
			'merge-base',
			'status-create',
			'read-back',
		]),
		reason: Schema.String,
	}
) {
	override get message(): string {
		return `the risk rating stopped before step 1 finished (${this.stage}): ${this.reason}`
	}
}
