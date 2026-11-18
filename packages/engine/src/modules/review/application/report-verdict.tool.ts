import { SEVERITIES, VERDICTS } from '@mng-review/domain'
import { Schema } from 'effect'
import { Tool } from 'effect/ai'

/**
 * The finish tool of a validator. Answers are decoded with the domain's verdict schema, which also
 * requires evidence for a confirmation.
 */
export const ReportVerdictTool = Tool.make('report_verdict', {
	description:
		'Confirm or reject the finding, with a re-rated severity and evidence.',
	parameters: Schema.Struct({
		verdict: Schema.Literals(VERDICTS),
		severity: Schema.Literals(SEVERITIES),
		reason: Schema.String.annotate({ description: 'One or two sentences.' }),
		evidence: Schema.Array(Schema.String).annotate({
			description: '`path:line` entries, each with a few words.',
		}),
	}),
	success: Schema.String,
})
