import {
	MAX_FINDING_FIX_CHARS,
	MAX_FINDING_IMPACT_CHARS,
	MAX_FINDING_STEP_CHARS,
	MAX_FINDING_TITLE_CHARS,
	SEVERITIES,
} from '@mng-review/domain'
import { Schema } from 'effect'
import { Tool } from 'effect/ai'

/**
 * The finding shape the model sees. Answers are decoded leniently by the findings answer parser,
 * not by this schema, so it carries no numeric bounds or string patterns: some providers reject
 * `minimum`, `maximum` and similar keywords in tool schemas.
 */
const findingParametersSchema = Schema.Struct({
	path: Schema.String.annotate({
		description: 'Repository-relative file path.',
	}),
	line: Schema.Number.annotate({
		description: 'Line number at head, a whole number.',
	}),
	severity: Schema.Literals(SEVERITIES),
	title: Schema.String.annotate({
		description: `One line naming what breaks, at most ${MAX_FINDING_TITLE_CHARS} characters.`,
	}),
	trigger: Schema.String.annotate({
		description: `The steps that make it happen, one short step per line, at most five, each at most ${MAX_FINDING_STEP_CHARS} characters.`,
	}),
	impact: Schema.String.annotate({
		description: `What goes wrong and for whom, two or three sentences, at most ${MAX_FINDING_IMPACT_CHARS} characters.`,
	}),
	evidence: Schema.Array(Schema.String).annotate({
		description: '`path:line` notes.',
	}),
	suggestion: Schema.optionalKey(Schema.String).annotate({
		description: `One sentence on what to change, at most ${MAX_FINDING_FIX_CHARS} characters.`,
	}),
})

/** The finish tool of a finder: every finding of the review at once. */
export const ReportFindingsTool = Tool.make('report_findings', {
	description:
		'Report every finding of this review at once. An empty list means no problems.',
	parameters: Schema.Struct({
		findings: Schema.Array(findingParametersSchema),
	}),
	success: Schema.String,
})
