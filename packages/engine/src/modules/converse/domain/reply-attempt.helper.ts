import {
	type Finding,
	formatSchemaIssue,
	type ReplyClaim,
	replyAnswerSchema,
	toReplyClaim,
} from '@mng-review/domain'
import { Cause, Effect, Predicate, Schema } from 'effect'
import { FILE_WINDOW_LINES, NO_MODEL_LEFT } from './reply.constants'

/** Reads a `report_reply` answer; the schema's reasons go back to the model. */
export function parseReplyAnswer(answer: unknown) {
	return Schema.decodeUnknownEffect(replyAnswerSchema)(answer).pipe(
		Effect.map(toReplyClaim),
		Effect.mapError(error => ({ message: formatSchemaIssue(error.issue) }))
	)
}

/** A classifier's claim and the keys of the lines its conversation showed it whole; see `getShownKeys`. */
export interface Classified {
	readonly claim: ReplyClaim
	readonly reads: ReadonlySet<string>
}

/** The finding as the classifier's first message shows it. */
export function toReportedFinding(finding: Finding) {
	const { path, line, severity, title, trigger, impact, evidence } = finding
	return { path, line, severity, title, trigger, impact, evidence }
}

/** The `read_file` range around a finding's line. */
export function toFileWindow(line: number): string {
	return `${Math.max(1, line - FILE_WINDOW_LINES)}-${line + FILE_WINDOW_LINES}`
}

/** Why a classifier attempt gave no claim: a loop or model failure, or no model left. */
export interface AttemptFailure {
	readonly _tag?: string
	readonly message: string
}

/** True when a failure must not be tried again: no model left or the run's tokens spent. */
export function isFinal(error: AttemptFailure): boolean {
	return error.message === NO_MODEL_LEFT || error._tag === 'TokenBudgetError'
}

/** Why deciding on a reply failed, a defect included. */
export function toCauseMessage(cause: Cause.Cause<AttemptFailure>): string {
	const error = Cause.squash(cause)
	if (
		Predicate.hasProperty(error, 'message') &&
		Predicate.isString(error.message)
	)
		return error.message
	return String(error)
}
