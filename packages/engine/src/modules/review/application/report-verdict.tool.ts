import {
	MAX_PREMISE_CHARS,
	MAX_VERDICT_REASON_CHARS,
	SEVERITIES,
	VERDICTS,
} from '@mng-review/domain'
import { Schema } from 'effect'
import { Tool } from 'effect/ai'

/**
 * The finish tool of a validator. Answers are decoded with the domain's verdict schema, which also
 * requires evidence for a confirmation or an unverified answer and a premise for the latter.
 * `lowered_because` is what lets the validator lower the reported severity, and `edit` is a fix the
 * engine checks against the head before a comment suggests it.
 */
export const ReportVerdictTool = Tool.make('report_verdict', {
	description:
		'Confirm, reject or mark the finding unverified, with a re-rated severity and evidence.',
	parameters: Schema.Struct({
		verdict: Schema.Literals(VERDICTS),
		severity: Schema.Literals(SEVERITIES),
		reason: Schema.String.annotate({
			description: `One or two plain sentences, at most ${MAX_VERDICT_REASON_CHARS} characters.`,
		}),
		evidence: Schema.Array(Schema.String).annotate({
			description: '`path:line` entries, each with a few words.',
		}),
		premise: Schema.optionalKey(
			Schema.String.annotate({
				description: `For unverified only: the dependency behaviour the finding rests on, as one sentence naming the package, at most ${MAX_PREMISE_CHARS} characters.`,
			})
		),
		same_root_cause: Schema.optionalKey(
			Schema.Array(Schema.Number).annotate({
				description:
					'Numbers of the listed nearby findings that describe the same defect as this one.',
			})
		),
		edit: Schema.optionalKey(
			Schema.Struct({
				line: Schema.String.annotate({
					description:
						"The finding's line at head, copied exactly without its line number.",
				}),
				replacement: Schema.String.annotate({
					description:
						'The code that replaces that line, one or more lines with their indentation.',
				}),
			}).annotate({
				description:
					"For confirm only, when the whole fix is one edit of the finding's line.",
			})
		),
		lowered_because: Schema.optionalKey(
			Schema.String.annotate({
				description:
					'Only when severity is lower than reported: the reported level and the part of its criterion that fails.',
			})
		),
	}),
	success: Schema.String,
})
