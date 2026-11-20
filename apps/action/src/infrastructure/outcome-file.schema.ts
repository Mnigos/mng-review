import { commitShaSchema, countSchema } from '@mng-review/domain'
import {
	MAX_RECHECKS,
	MAX_REPORT_TEXT,
	reviewReportSchema,
	tokensByModelSchema,
} from '@mng-review/github'
import { Schema } from 'effect'
import { RUN_TRIGGERS } from './command-run.config'

/** Bumped when a field of the outcome file changes meaning or goes away. */
export const OUTCOME_VERSION = 1
/** The outcome file's largest size; a longer text is refused before it is parsed. */
export const MAX_OUTCOME_BYTES = 4 * 1024 * 1024
export const OUTCOME_STATUSES = [
	'reviewed',
	'offline',
	'skipped',
	'invalid-config',
	'failed',
] as const

const textSchema = Schema.String.check(Schema.isMaxLength(MAX_REPORT_TEXT))

/**
 * The run and pull request the outcome belongs to. Publishing compares it with what the runner
 * and the event say, never with the file alone.
 */
export const outcomeBindingSchema = Schema.Struct({
	/** `owner/name`, `GITHUB_REPOSITORY`. */
	repository: textSchema,
	runId: textSchema,
	runAttempt: textSchema,
	engineCommit: Schema.NullOr(commitShaSchema),
	pullNumber: Schema.Int,
	baseSha: commitShaSchema,
	headSha: commitShaSchema,
	/** What started the run, `MNG_REVIEW_TRIGGER`; a push outcome never publishes for a command. */
	trigger: Schema.Literals(RUN_TRIGGERS),
})
export type OutcomeBinding = typeof outcomeBindingSchema.Type

/** A thread the re-check proposes to resolve; publishing checks it again in its own read. */
export const recheckProposalSchema = Schema.Struct({
	/** The GraphQL node id, as read before the review. */
	threadId: textSchema,
	/** The thread marker's fingerprint. */
	fingerprint: textSchema,
	/** The validator's reason, shown escaped. */
	reason: textSchema,
})

/**
 * What the review hands to publishing: the binding, the status, the review report and the
 * re-check's proposals. It never holds the rules, the pull request's title or body, the run count,
 * a marker, a comment body, Markdown, a token or a key; publishing reads or builds those itself.
 */
export const outcomeFileSchema = Schema.Struct({
	version: Schema.Literal(OUTCOME_VERSION),
	binding: outcomeBindingSchema,
	status: Schema.Literals(OUTCOME_STATUSES),
	reason: Schema.optionalKey(textSchema),
	source: Schema.optionalKey(textSchema),
	report: Schema.optionalKey(reviewReportSchema),
	recheck: Schema.optionalKey(
		Schema.Struct({
			checked: countSchema,
			rejected: Schema.Array(recheckProposalSchema).check(
				Schema.isMaxLength(MAX_RECHECKS)
			),
			/** The job's tokens after the re-check. */
			tokens: tokensByModelSchema,
		})
	),
}).check(
	Schema.makeFilter(
		file =>
			file.status !== 'reviewed' ||
			file.report !== undefined ||
			'a reviewed outcome needs its report'
	)
)
export type OutcomeFile = typeof outcomeFileSchema.Type
